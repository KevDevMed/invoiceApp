/**
 * GGUF inference, behind an interface.
 *
 * `LlmRuntime` is the contract the IPC layer talks to. `NodeLlamaCppRuntime` is
 * the real implementation; `FakeLlmRuntime` is the deterministic double the
 * tests and headless environments use. Nothing above this file knows which one
 * it has, and a machine where the native backend refuses to load surfaces a
 * typed `RUNTIME_UNAVAILABLE` error in the UI rather than a crash.
 *
 * Keeping the main thread responsive
 * ----------------------------------
 * `node-llama-cpp` is imported dynamically, the first time a model is actually
 * loaded — the several-hundred-millisecond cost of pulling in the native addon
 * is not paid during app boot. Every call into it (`getLlama`, `loadModel`,
 * `createContext`, `prompt`) is promise-returning and does its work on
 * llama.cpp's own threads via libuv, so the V8 main thread is never blocked;
 * it only wakes up per token. Loads are additionally serialised through a
 * single-flight chain, so a second `llm:load` while one is in progress queues
 * instead of racing two mmaps of the same file.
 */

export type ChatRoleName = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatTurn {
  readonly role: ChatRoleName;
  readonly content: string;
}

export interface LoadModelOptions {
  readonly modelId: string;
  readonly modelPath: string;
  readonly contextSize?: number;
  readonly gpuLayers?: number;
}

export interface LoadedModel {
  readonly modelId: string;
  readonly modelPath: string;
  readonly contextSize: number;
}

export interface GenerateOptions {
  readonly requestId: string;
  readonly messages: readonly ChatTurn[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly onToken?: (token: string) => void;
}

export interface GenerateResult {
  readonly requestId: string;
  readonly text: string;
  readonly stopReason: 'stop' | 'length' | 'cancelled' | 'error';
}

export type RuntimeErrorCode =
  | 'RUNTIME_UNAVAILABLE'
  | 'MODEL_NOT_LOADED'
  | 'LOAD_FAILED'
  | 'GENERATION_FAILED';

export class LlmRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: RuntimeErrorCode,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmRuntimeError';
  }
}

export interface LlmRuntime {
  /** Load a model, unloading whichever one is currently resident. */
  load(options: LoadModelOptions): Promise<LoadedModel>;
  unload(): Promise<boolean>;
  current(): LoadedModel | null;
  generate(options: GenerateOptions): Promise<GenerateResult>;
  dispose(): Promise<void>;
}

export const DEFAULT_CONTEXT_SIZE = 4096;
export const DEFAULT_TEMPERATURE = 0.4;
export const DEFAULT_MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Prompt shaping
// ---------------------------------------------------------------------------

export interface ShapedPrompt {
  readonly systemPrompt: string;
  /** Everything before the final user turn, as alternating history. */
  readonly history: readonly ChatTurn[];
  readonly prompt: string;
}

/**
 * Split a message list into the three things a chat session needs.
 *
 * Tool results are folded into user turns: llama.cpp chat templates for these
 * models have no dedicated tool role, and inventing one produces worse output
 * than stating the result plainly.
 */
export function shapePrompt(messages: readonly ChatTurn[]): ShapedPrompt {
  const systemParts: string[] = [];
  const conversation: ChatTurn[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      conversation.push({ role: 'user', content: `Tool result:\n${message.content}` });
      continue;
    }
    conversation.push(message);
  }

  const lastUserIndex = conversation.map((turn) => turn.role).lastIndexOf('user');
  if (lastUserIndex === -1) {
    return { systemPrompt: systemParts.join('\n\n'), history: conversation, prompt: '' };
  }

  return {
    systemPrompt: systemParts.join('\n\n'),
    history: conversation.slice(0, lastUserIndex),
    prompt: conversation[lastUserIndex]?.content ?? '',
  };
}

// ---------------------------------------------------------------------------
// The real runtime
// ---------------------------------------------------------------------------

/**
 * Structural types for the slice of `node-llama-cpp` we use.
 *
 * Declared locally rather than imported so this file still type-checks on a
 * machine where the optional native dependency was never installed. The runtime
 * checks the shape it gets back before using it.
 */
interface LlamaModelLike {
  dispose(): Promise<void>;
  createContext(options: { contextSize?: number }): Promise<LlamaContextLike>;
}

interface LlamaContextLike {
  readonly contextSize: number;
  getSequence(): LlamaSequenceLike;
  dispose(): Promise<void>;
}

type LlamaSequenceLike = object;

interface LlamaChatSessionLike {
  setChatHistory(history: unknown[]): void;
  prompt(
    text: string,
    options: {
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
      stopOnAbortSignal?: boolean;
      onTextChunk?: (chunk: string) => void;
    },
  ): Promise<string>;
}

interface LlamaLike {
  loadModel(options: { modelPath: string; gpuLayers?: number }): Promise<LlamaModelLike>;
}

interface NodeLlamaCppModule {
  getLlama(options?: Record<string, unknown>): Promise<LlamaLike>;
  LlamaChatSession: new (options: {
    contextSequence: LlamaSequenceLike;
    systemPrompt?: string;
  }) => LlamaChatSessionLike;
}

/** Overridable so tests can inject a module double without touching the addon. */
export type NodeLlamaCppLoader = () => Promise<NodeLlamaCppModule>;

const defaultLoader: NodeLlamaCppLoader = async () => {
  // A bare dynamic import of a name the bundler must not try to resolve into
  // the renderer. In main this is externalised by electron-vite.
  const module = (await import('node-llama-cpp')) as unknown as NodeLlamaCppModule;
  if (typeof module.getLlama !== 'function' || typeof module.LlamaChatSession !== 'function') {
    throw new LlmRuntimeError(
      'node-llama-cpp loaded but does not expose getLlama/LlamaChatSession.',
      'RUNTIME_UNAVAILABLE',
    );
  }
  return module;
};

interface Resident {
  readonly info: LoadedModel;
  readonly model: LlamaModelLike;
  readonly context: LlamaContextLike;
}

export class NodeLlamaCppRuntime implements LlmRuntime {
  private llama: LlamaLike | null = null;
  private module: NodeLlamaCppModule | null = null;
  private resident: Resident | null = null;
  /** Serialises load/unload so two `llm:load` calls cannot race the same file. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly loader: NodeLlamaCppLoader = defaultLoader) {}

  current(): LoadedModel | null {
    return this.resident?.info ?? null;
  }

  async load(options: LoadModelOptions): Promise<LoadedModel> {
    return this.enqueue(async () => {
      const module = await this.ensureModule();
      const llama = await this.ensureLlama(module);

      // One model resident at a time: the second load frees the first, rather
      // than holding two multi-gigabyte mmaps and letting the OS decide.
      await this.disposeResident();

      const contextSize = options.contextSize ?? DEFAULT_CONTEXT_SIZE;
      try {
        const model = await llama.loadModel({
          modelPath: options.modelPath,
          gpuLayers: options.gpuLayers,
        });
        const context = await model.createContext({ contextSize });
        const info: LoadedModel = {
          modelId: options.modelId,
          modelPath: options.modelPath,
          contextSize: context.contextSize ?? contextSize,
        };
        this.resident = { info, model, context };
        return info;
      } catch (error) {
        throw new LlmRuntimeError(
          `Could not load ${options.modelId}: ${errorMessage(error)}`,
          'LOAD_FAILED',
          error,
        );
      }
    });
  }

  async unload(): Promise<boolean> {
    return this.enqueue(async () => {
      const had = this.resident !== null;
      await this.disposeResident();
      return had;
    });
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const resident = this.resident;
    const module = this.module;
    if (!resident || !module) {
      throw new LlmRuntimeError('No model is loaded.', 'MODEL_NOT_LOADED');
    }

    const shaped = shapePrompt(options.messages);
    let text = '';

    try {
      const session = new module.LlamaChatSession({
        contextSequence: resident.context.getSequence(),
        systemPrompt: shaped.systemPrompt || undefined,
      });

      if (shaped.history.length > 0) {
        session.setChatHistory(toChatHistory(shaped.systemPrompt, shaped.history));
      }

      text = await session.prompt(shaped.prompt, {
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal: options.signal,
        stopOnAbortSignal: true,
        onTextChunk: (chunk) => options.onToken?.(chunk),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        return { requestId: options.requestId, text, stopReason: 'cancelled' };
      }
      throw new LlmRuntimeError(`Generation failed: ${errorMessage(error)}`, 'GENERATION_FAILED', error);
    }

    if (options.signal?.aborted) {
      return { requestId: options.requestId, text, stopReason: 'cancelled' };
    }
    return { requestId: options.requestId, text, stopReason: 'stop' };
  }

  async dispose(): Promise<void> {
    await this.enqueue(async () => {
      await this.disposeResident();
      this.llama = null;
      this.module = null;
    });
  }

  private async ensureModule(): Promise<NodeLlamaCppModule> {
    if (this.module) return this.module;
    try {
      this.module = await this.loader();
      return this.module;
    } catch (error) {
      if (error instanceof LlmRuntimeError) throw error;
      throw new LlmRuntimeError(
        `Local inference is unavailable: node-llama-cpp could not be loaded (${errorMessage(error)}).`,
        'RUNTIME_UNAVAILABLE',
        error,
      );
    }
  }

  private async ensureLlama(module: NodeLlamaCppModule): Promise<LlamaLike> {
    if (this.llama) return this.llama;
    try {
      this.llama = await module.getLlama();
      return this.llama;
    } catch (error) {
      throw new LlmRuntimeError(
        `Local inference is unavailable: no compatible llama.cpp backend (${errorMessage(error)}).`,
        'RUNTIME_UNAVAILABLE',
        error,
      );
    }
  }

  private async disposeResident(): Promise<void> {
    const resident = this.resident;
    this.resident = null;
    if (!resident) return;
    await resident.context.dispose().catch(() => undefined);
    await resident.model.dispose().catch(() => undefined);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    // Keep the chain alive even when a task rejects, or every later load fails.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function toChatHistory(systemPrompt: string, history: readonly ChatTurn[]): unknown[] {
  const items: unknown[] = [];
  if (systemPrompt) items.push({ type: 'system', text: systemPrompt });
  for (const turn of history) {
    if (turn.role === 'assistant') {
      items.push({ type: 'model', response: [turn.content] });
    } else {
      items.push({ type: 'user', text: turn.content });
    }
  }
  return items;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The test double
// ---------------------------------------------------------------------------

export interface FakeRuntimeOptions {
  /** Reply to produce, or a function of the shaped prompt. */
  readonly reply?: string | ((prompt: ShapedPrompt) => string);
  /** Milliseconds between emitted tokens. Zero keeps tests instant. */
  readonly tokenDelayMs?: number;
  /** Make `load` reject, to exercise the error path in the UI. */
  readonly failLoad?: boolean;
}

/**
 * A runtime that streams a scripted reply.
 *
 * Used by the unit tests and as the fallback on machines where the native
 * backend will not load, so the rest of the app can still be exercised.
 */
export class FakeLlmRuntime implements LlmRuntime {
  private resident: LoadedModel | null = null;

  constructor(private readonly options: FakeRuntimeOptions = {}) {}

  current(): LoadedModel | null {
    return this.resident;
  }

  async load(options: LoadModelOptions): Promise<LoadedModel> {
    if (this.options.failLoad) {
      throw new LlmRuntimeError(`Could not load ${options.modelId}: fake failure.`, 'LOAD_FAILED');
    }
    this.resident = {
      modelId: options.modelId,
      modelPath: options.modelPath,
      contextSize: options.contextSize ?? DEFAULT_CONTEXT_SIZE,
    };
    return this.resident;
  }

  async unload(): Promise<boolean> {
    const had = this.resident !== null;
    this.resident = null;
    return had;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    if (!this.resident) {
      throw new LlmRuntimeError('No model is loaded.', 'MODEL_NOT_LOADED');
    }

    const shaped = shapePrompt(options.messages);
    const reply =
      typeof this.options.reply === 'function'
        ? this.options.reply(shaped)
        : (this.options.reply ?? `Echo: ${shaped.prompt}`);

    let text = '';
    for (const token of reply.split(/(\s+)/).filter((part) => part.length > 0)) {
      if (options.signal?.aborted) {
        return { requestId: options.requestId, text, stopReason: 'cancelled' };
      }
      text += token;
      options.onToken?.(token);
      if (this.options.tokenDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.options.tokenDelayMs));
      }
    }

    return { requestId: options.requestId, text, stopReason: 'stop' };
  }

  async dispose(): Promise<void> {
    this.resident = null;
  }
}
