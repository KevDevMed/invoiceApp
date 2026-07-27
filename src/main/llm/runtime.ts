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

/**
 * Whether the model is allowed to spend tokens on chain-of-thought.
 *
 * `off` is the default because every model in this app's catalog is a Qwen3
 * variant, and Qwen3 reasons by default: `node-llama-cpp` keeps thought
 * segments out of `onTextChunk` and out of `responseText`, so a reasoning turn
 * that runs out of budget hands back an empty answer.
 */
export type ThinkingMode = 'auto' | 'off';

export interface GenerateOptions {
  readonly requestId: string;
  readonly messages: readonly ChatTurn[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
  readonly onToken?: (token: string) => void;
  readonly thinking?: ThinkingMode;
}

/**
 * `reasoning_only` is not an error: the model ran to completion but every token
 * it produced was a thought segment, so there is no answer to show. It is a
 * distinct stop reason so the caller can say that in the UI instead of
 * persisting an empty assistant message.
 */
export type GenerateStopReason = 'stop' | 'length' | 'cancelled' | 'error' | 'reasoning_only';

export interface GenerateResult {
  readonly requestId: string;
  readonly text: string;
  readonly stopReason: GenerateStopReason;
  /** Chain-of-thought text, when the model emitted thought segments. */
  readonly thoughts?: string;
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

/**
 * A context is created with a finite number of sequences (one, by default), and
 * `getSequence()` hands out one of them. `dispose()` gives the slot back;
 * `clearHistory()` resets the sequence state so the same slot can serve the
 * next chat. Both are real `LlamaContextSequence` members —
 * `node_modules/node-llama-cpp/dist/evaluator/LlamaContext/LlamaContext.d.ts`
 * declares `dispose(): void`, `get disposed(): boolean` and
 * `clearHistory(): Promise<void>`.
 */
interface LlamaSequenceLike {
  dispose(): void;
  clearHistory(): Promise<void>;
  readonly disposed?: boolean;
}

interface ChatWrapperLike {
  readonly wrapperName?: string;
  readonly variation?: string;
}

interface PromptSegment {
  readonly type?: string;
  readonly segmentType?: string;
  readonly text?: string;
}

/** The shape `promptWithMeta` returns, narrowed to the parts used here. */
interface PromptWithMetaResult {
  readonly response?: readonly (string | PromptSegment | Record<string, unknown>)[];
  readonly responseText?: string;
  readonly stopReason?: string;
}

interface PromptCallOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  stopOnAbortSignal?: boolean;
  onTextChunk?: (chunk: string) => void;
  budgets?: { thoughtTokens?: number };
}

interface LlamaChatSessionLike {
  readonly chatWrapper?: ChatWrapperLike;
  setChatHistory(history: unknown[]): void;
  prompt(text: string, options: PromptCallOptions): Promise<string>;
  /** Present since node-llama-cpp 3.x; the runtime falls back to `prompt`. */
  promptWithMeta?(text: string, options: PromptCallOptions): Promise<PromptWithMetaResult>;
  dispose?(options?: { disposeSequence?: boolean }): void;
}

interface LlamaLike {
  loadModel(options: { modelPath: string; gpuLayers?: number }): Promise<LlamaModelLike>;
}

interface NodeLlamaCppModule {
  getLlama(options?: Record<string, unknown>): Promise<LlamaLike>;
  LlamaChatSession: new (options: {
    contextSequence: LlamaSequenceLike;
    systemPrompt?: string;
    chatWrapper?: ChatWrapperLike;
    autoDisposeSequence?: boolean;
  }) => LlamaChatSessionLike;
  /** Only used to turn Qwen3's default reasoning off. Optional on purpose. */
  QwenChatWrapper?: new (options?: {
    thoughts?: 'auto' | 'discourage';
    variation?: string;
    keepOnlyLastThought?: boolean;
  }) => ChatWrapperLike;
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
  /**
   * The one sequence every chat on this model borrows.
   *
   * Owned by the runtime, not by the chat: a `LlamaChatSession` is created with
   * `autoDisposeSequence: false` and disposed at the end of its turn, while the
   * sequence itself is reset (`clearHistory`) and handed to the next chat. It is
   * disposed with the context in `disposeResident`, and dropped early if a chat
   * leaves it in an unknown state.
   */
  sequence: LlamaSequenceLike | null;
}

export class NodeLlamaCppRuntime implements LlmRuntime {
  private llama: LlamaLike | null = null;
  private module: NodeLlamaCppModule | null = null;
  private resident: Resident | null = null;
  /** Serialises load/unload so two `llm:load` calls cannot race the same file. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Serialises chats, because they share the resident model's one sequence. */
  private chats: Promise<unknown> = Promise.resolve();

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
        this.resident = { info, model, context, sequence: null };
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

    // Chats queue rather than race: they share one sequence, and asking a
    // one-sequence context for a second one is what "No sequences left" means.
    const run = this.chats.then(
      () => this.runChat(module, resident, options),
      () => this.runChat(module, resident, options),
    );
    this.chats = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One chat turn, from borrowing the sequence to giving it back. */
  private async runChat(
    module: NodeLlamaCppModule,
    resident: Resident,
    options: GenerateOptions,
  ): Promise<GenerateResult> {
    // The model may have been unloaded while this chat sat in the queue.
    if (this.resident !== resident) {
      throw new LlmRuntimeError('No model is loaded.', 'MODEL_NOT_LOADED');
    }

    const sequence = this.acquireSequence(resident);
    const shaped = shapePrompt(options.messages);
    const thinking = options.thinking ?? DEFAULT_THINKING;
    let session: LlamaChatSessionLike | null = null;
    let streamed = '';
    let healthy = false;

    try {
      session = this.createSession(module, sequence, shaped.systemPrompt, thinking);

      if (shaped.history.length > 0) {
        session.setChatHistory(toChatHistory(shaped.systemPrompt, shaped.history));
      }

      const promptOptions: PromptCallOptions = {
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal: options.signal,
        stopOnAbortSignal: true,
        onTextChunk: (chunk) => {
          streamed += chunk;
          options.onToken?.(chunk);
        },
        // Cap what a reasoning model may spend on thoughts, so it cannot burn
        // the whole token budget before it starts answering.
        budgets: { thoughtTokens: thinking === 'off' ? 0 : undefined },
      };

      // `promptWithMeta` is the non-streaming return value: it carries the
      // final `responseText` and the full segmented `response`, which is the
      // only place thought segments appear. `onTextChunk` sees main-response
      // text only, so a thinking model streams nothing at all.
      const meta =
        typeof session.promptWithMeta === 'function'
          ? await session.promptWithMeta(shaped.prompt, promptOptions)
          : { responseText: await session.prompt(shaped.prompt, promptOptions) };

      healthy = true;
      const responseText = meta.responseText ?? '';
      const text = responseText.length > 0 ? responseText : streamed;
      const thoughts = collectThoughts(meta.response);

      if (options.signal?.aborted) {
        return { requestId: options.requestId, text, stopReason: 'cancelled', thoughts };
      }
      if (text.trim().length === 0 && thoughts.trim().length > 0) {
        return { requestId: options.requestId, text: '', stopReason: 'reasoning_only', thoughts };
      }
      return { requestId: options.requestId, text, stopReason: mapStopReason(meta.stopReason), thoughts };
    } catch (error) {
      if (options.signal?.aborted) {
        return { requestId: options.requestId, text: streamed, stopReason: 'cancelled' };
      }
      throw new LlmRuntimeError(`Generation failed: ${errorMessage(error)}`, 'GENERATION_FAILED', error);
    } finally {
      // `disposeSequence: false` — the session is per-turn, the sequence is not.
      try {
        session?.dispose?.({ disposeSequence: false });
      } catch {
        healthy = false;
      }
      await this.releaseSequence(resident, sequence, healthy);
    }
  }

  /** Borrow the resident sequence, creating it the first time it is needed. */
  private acquireSequence(resident: Resident): LlamaSequenceLike {
    const existing = resident.sequence;
    if (existing && existing.disposed !== true) return existing;
    const sequence = resident.context.getSequence();
    resident.sequence = sequence;
    return sequence;
  }

  /**
   * Give the sequence back for the next chat.
   *
   * A clean turn resets the sequence state and keeps the slot. Anything else —
   * a throw, an abort mid-generation, a `clearHistory` that fails — disposes it,
   * so the slot is returned to the context and the next chat starts from a fresh
   * one rather than inheriting an unknown state.
   */
  private async releaseSequence(
    resident: Resident,
    sequence: LlamaSequenceLike,
    healthy: boolean,
  ): Promise<void> {
    if (healthy) {
      try {
        await sequence.clearHistory();
        return;
      } catch {
        // Fall through to disposal.
      }
    }
    disposeSequence(sequence);
    if (resident.sequence === sequence) resident.sequence = null;
  }

  /**
   * Build the chat session for one turn.
   *
   * With thinking off and a Qwen model, the session is rebuilt around a
   * `QwenChatWrapper({thoughts: 'discourage'})` — Qwen3's own no-think switch,
   * which primes the response with an empty `<think></think>` block so the model
   * answers directly. The first session is only used to see which wrapper
   * `node-llama-cpp` resolved; constructing one evaluates nothing.
   */
  private createSession(
    module: NodeLlamaCppModule,
    sequence: LlamaSequenceLike,
    systemPrompt: string,
    thinking: ThinkingMode,
  ): LlamaChatSessionLike {
    const base = {
      contextSequence: sequence,
      systemPrompt: systemPrompt || undefined,
      autoDisposeSequence: false,
    };
    const session = new module.LlamaChatSession(base);
    if (thinking !== 'off') return session;

    const wrapper = session.chatWrapper;
    if (wrapper?.wrapperName !== 'Qwen' || typeof module.QwenChatWrapper !== 'function') return session;

    try {
      session.dispose?.({ disposeSequence: false });
      return new module.LlamaChatSession({
        ...base,
        chatWrapper: new module.QwenChatWrapper({
          thoughts: 'discourage',
          variation: wrapper.variation,
        }),
      });
    } catch {
      // A wrapper this build will not construct is not worth failing a chat for.
      return new module.LlamaChatSession(base);
    }
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
    if (resident.sequence) {
      disposeSequence(resident.sequence);
      resident.sequence = null;
    }
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

/**
 * Thinking is off unless a caller asks for it.
 *
 * Every entry in this app's catalog is a Qwen3 variant, and a thinking Qwen3
 * spends its whole budget reasoning and returns nothing to show the user.
 */
export const DEFAULT_THINKING: ThinkingMode = 'off';

function disposeSequence(sequence: LlamaSequenceLike): void {
  try {
    if (sequence.disposed !== true) sequence.dispose();
  } catch {
    // A sequence that will not dispose is already gone as far as we care.
  }
}

/** Join the thought segments out of a `promptWithMeta` response array. */
function collectThoughts(response: PromptWithMetaResult['response']): string {
  if (!Array.isArray(response)) return '';
  const parts: string[] = [];
  for (const item of response) {
    if (typeof item !== 'object' || item === null) continue;
    const segment = item as PromptSegment;
    if (segment.type === 'segment' && segment.segmentType === 'thought' && segment.text) {
      parts.push(segment.text);
    }
  }
  return parts.join('');
}

function mapStopReason(stopReason: string | undefined): GenerateStopReason {
  switch (stopReason) {
    case 'maxTokens':
      return 'length';
    case 'abort':
      return 'cancelled';
    default:
      return 'stop';
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
  /** Answer with thoughts and no text, the way a reasoning model can. */
  readonly thoughtsOnly?: string;
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

    if (this.options.thoughtsOnly) {
      return {
        requestId: options.requestId,
        text: '',
        stopReason: 'reasoning_only',
        thoughts: this.options.thoughtsOnly,
      };
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
