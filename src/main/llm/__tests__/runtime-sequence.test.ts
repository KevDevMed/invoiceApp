/**
 * Sequence ownership and reasoning-model handling in `NodeLlamaCppRuntime`.
 *
 * The regression these cover is a runtime-only defect: the runtime took a fresh
 * `context.getSequence()` for every chat and never gave one back, so the second
 * message on a loaded model died with `No sequences left`. The doubles below
 * model that exactly — `FakeContext` hands out a finite number of sequences and
 * only reclaims one when it is disposed.
 */

import { describe, expect, it } from 'vitest';

import { NodeLlamaCppRuntime, type ChatTurn } from '../runtime';

interface SessionCall {
  readonly prompt: string;
  readonly history: unknown[] | null;
  readonly wrapperName: string | undefined;
  readonly thoughts: string | undefined;
  readonly thoughtBudget: number | undefined;
}

interface ScriptedTurn {
  readonly responseText?: string;
  readonly thoughts?: string;
  readonly stopReason?: string;
  readonly throws?: string;
  /** Called with the chunk emitter, to drive cancellation mid-generation. */
  readonly onGenerate?: (emit: (chunk: string) => void) => void | Promise<void>;
}

class FakeSequence {
  disposed = false;
  cleared = 0;

  constructor(private readonly onDispose: () => void) {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose();
  }

  async clearHistory(): Promise<void> {
    this.cleared += 1;
  }
}

class FakeContext {
  readonly contextSize = 1024;
  readonly handedOut: FakeSequence[] = [];
  disposed = false;
  private free: number;

  constructor(private readonly sequenceCount = 1) {
    this.free = sequenceCount;
  }

  getSequence(): FakeSequence {
    if (this.free <= 0) throw new Error('No sequences left');
    this.free -= 1;
    const sequence = new FakeSequence(() => {
      this.free = Math.min(this.free + 1, this.sequenceCount);
    });
    this.handedOut.push(sequence);
    return sequence;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeModel {
  context: FakeContext | null = null;
  disposed = false;

  constructor(private readonly sequenceCount: number) {}

  async createContext(): Promise<FakeContext> {
    this.context = new FakeContext(this.sequenceCount);
    return this.context;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function buildModule(options: {
  script: ScriptedTurn[];
  sequenceCount?: number;
  wrapperName?: string;
}): {
  module: Record<string, unknown>;
  calls: SessionCall[];
  models: FakeModel[];
  sessionDisposals: { disposeSequence: boolean | undefined }[];
} {
  const calls: SessionCall[] = [];
  const models: FakeModel[] = [];
  const sessionDisposals: { disposeSequence: boolean | undefined }[] = [];
  let turn = 0;

  class FakeQwenChatWrapper {
    readonly wrapperName = 'Qwen';
    readonly thoughts: string;

    constructor(wrapperOptions?: { thoughts?: string }) {
      this.thoughts = wrapperOptions?.thoughts ?? 'auto';
    }
  }

  class FakeChatSession {
    readonly chatWrapper: { wrapperName?: string; thoughts?: string };
    private history: unknown[] | null = null;
    private readonly sequence: FakeSequence;

    constructor(sessionOptions: {
      contextSequence: FakeSequence;
      chatWrapper?: { wrapperName?: string; thoughts?: string };
      autoDisposeSequence?: boolean;
    }) {
      this.sequence = sessionOptions.contextSequence;
      if (this.sequence.disposed) throw new Error('sequence is disposed');
      this.chatWrapper = sessionOptions.chatWrapper ?? {
        wrapperName: options.wrapperName ?? 'Qwen',
        thoughts: 'auto',
      };
    }

    setChatHistory(history: unknown[]): void {
      this.history = history;
    }

    async promptWithMeta(
      prompt: string,
      promptOptions: {
        onTextChunk?: (chunk: string) => void;
        budgets?: { thoughtTokens?: number };
      },
    ): Promise<{ response: unknown[]; responseText: string; stopReason: string }> {
      calls.push({
        prompt,
        history: this.history,
        wrapperName: this.chatWrapper.wrapperName,
        thoughts: this.chatWrapper.thoughts,
        thoughtBudget: promptOptions.budgets?.thoughtTokens,
      });

      const scripted = options.script[Math.min(turn, options.script.length - 1)];
      turn += 1;
      await scripted?.onGenerate?.((chunk) => promptOptions.onTextChunk?.(chunk));
      if (scripted?.throws) throw new Error(scripted.throws);

      const responseText = scripted?.responseText ?? '';
      if (responseText.length > 0) promptOptions.onTextChunk?.(responseText);

      const response: unknown[] = [];
      if (scripted?.thoughts) {
        response.push({
          type: 'segment',
          segmentType: 'thought',
          ended: true,
          text: scripted.thoughts,
        });
      }
      if (responseText.length > 0) response.push(responseText);

      return { response, responseText, stopReason: scripted?.stopReason ?? 'eogToken' };
    }

    /** The pre-3.x surface, kept so the fallback path is exercisable. */
    async prompt(
      prompt: string,
      promptOptions: {
        onTextChunk?: (chunk: string) => void;
        budgets?: { thoughtTokens?: number };
      },
    ): Promise<string> {
      const meta = await this.promptWithMeta(prompt, promptOptions);
      return meta.responseText;
    }

    dispose(disposeOptions?: { disposeSequence?: boolean }): void {
      sessionDisposals.push({ disposeSequence: disposeOptions?.disposeSequence });
    }
  }

  const module = {
    getLlama: async () => ({
      loadModel: async () => {
        const model = new FakeModel(options.sequenceCount ?? 1);
        models.push(model);
        return model;
      },
    }),
    LlamaChatSession: FakeChatSession,
    QwenChatWrapper: FakeQwenChatWrapper,
  };

  return { module, calls, models, sessionDisposals };
}

async function loadedRuntime(options: {
  script: ScriptedTurn[];
  sequenceCount?: number;
  wrapperName?: string;
}) {
  const built = buildModule(options);
  // The module shape is structural and not exported, so the double goes in as
  // `never` — the runtime only ever touches the members declared above.
  const runtime = new NodeLlamaCppRuntime(async () => built.module as never);
  await runtime.load({ modelId: 'qwen3-test', modelPath: '/tmp/model.gguf', contextSize: 1024 });
  return { runtime, ...built };
}

const HELLO: ChatTurn[] = [{ role: 'user', content: 'hello' }];

describe('NodeLlamaCppRuntime sequence ownership', () => {
  it('runs many sequential chats on a context that only has one sequence', async () => {
    // The regression test for `No sequences left`: before the fix, the second
    // call here threw because nothing released the first sequence.
    const { runtime, models } = await loadedRuntime({
      script: [{ responseText: 'ok' }],
      sequenceCount: 1,
    });

    for (let index = 0; index < 5; index += 1) {
      const result = await runtime.generate({
        requestId: `r${index}`,
        messages: [{ role: 'user', content: `message ${index}` }],
      });
      expect(result.stopReason).toBe('stop');
      expect(result.text).toBe('ok');
    }

    // One sequence, borrowed and reset five times.
    expect(models[0]?.context?.handedOut).toHaveLength(1);
    expect(models[0]?.context?.handedOut[0]?.cleared).toBe(5);
  });

  it('disposes the session per turn without disposing the sequence', async () => {
    const { runtime, sessionDisposals } = await loadedRuntime({ script: [{ responseText: 'ok' }] });

    await runtime.generate({ requestId: 'r1', messages: HELLO });
    await runtime.generate({ requestId: 'r2', messages: HELLO });

    expect(sessionDisposals.length).toBeGreaterThanOrEqual(2);
    expect(sessionDisposals.every((entry) => entry.disposeSequence === false)).toBe(true);
  });

  it('keeps chatting after a cancelled chat', async () => {
    const controller = new AbortController();
    const { runtime, models } = await loadedRuntime({
      script: [
        {
          onGenerate: (emit) => {
            emit('par');
            controller.abort();
            throw new Error('aborted');
          },
        },
        { responseText: 'after cancel' },
      ],
    });

    const cancelled = await runtime.generate({
      requestId: 'r1',
      messages: HELLO,
      signal: controller.signal,
    });
    expect(cancelled.stopReason).toBe('cancelled');
    expect(cancelled.text).toBe('par');

    const next = await runtime.generate({ requestId: 'r2', messages: HELLO });
    expect(next.text).toBe('after cancel');

    // The cancelled turn's sequence was disposed rather than reused, so the
    // context handed out a second one — and had a free slot to hand out.
    const handedOut = models[0]?.context?.handedOut ?? [];
    expect(handedOut).toHaveLength(2);
    expect(handedOut[0]?.disposed).toBe(true);
  });

  it('keeps chatting after a chat that throws mid-generation', async () => {
    const { runtime, models } = await loadedRuntime({
      script: [{ throws: 'kv cache exploded' }, { responseText: 'still here' }],
    });

    await expect(runtime.generate({ requestId: 'r1', messages: HELLO })).rejects.toThrow(
      'Generation failed: kv cache exploded',
    );

    const next = await runtime.generate({ requestId: 'r2', messages: HELLO });
    expect(next.text).toBe('still here');
    expect(models[0]?.context?.handedOut[0]?.disposed).toBe(true);
  });

  it('survives switching threads, which changes the chat history', async () => {
    const { runtime, calls } = await loadedRuntime({ script: [{ responseText: 'ok' }] });

    await runtime.generate({
      requestId: 'r1',
      messages: [
        { role: 'user', content: 'thread A first' },
        { role: 'assistant', content: 'A reply' },
        { role: 'user', content: 'thread A second' },
      ],
    });
    await runtime.generate({ requestId: 'r2', messages: [{ role: 'user', content: 'thread B' }] });

    expect(calls[0]?.history).not.toBeNull();
    expect(calls[1]?.prompt).toBe('thread B');
    expect(calls[1]?.history).toBeNull();
  });

  it('releases the sequence when the model is unloaded', async () => {
    const { runtime, models } = await loadedRuntime({ script: [{ responseText: 'ok' }] });
    await runtime.generate({ requestId: 'r1', messages: HELLO });

    const sequence = models[0]?.context?.handedOut[0];
    expect(sequence?.disposed).toBe(false);

    await runtime.unload();
    expect(sequence?.disposed).toBe(true);
    expect(models[0]?.context?.disposed).toBe(true);
  });

  it('queues concurrent chats instead of racing them for the one sequence', async () => {
    const { runtime, models } = await loadedRuntime({
      script: [{ responseText: 'first' }, { responseText: 'second' }],
    });

    const [first, second] = await Promise.all([
      runtime.generate({ requestId: 'r1', messages: HELLO }),
      runtime.generate({ requestId: 'r2', messages: HELLO }),
    ]);

    expect(first.text).toBe('first');
    expect(second.text).toBe('second');
    expect(models[0]?.context?.handedOut).toHaveLength(1);
  });
});

describe('NodeLlamaCppRuntime and reasoning models', () => {
  it('reports thought-only output as reasoning_only rather than an empty answer', async () => {
    const { runtime } = await loadedRuntime({
      script: [{ responseText: '', thoughts: 'Let me count the words...' }],
    });

    const result = await runtime.generate({ requestId: 'r1', messages: HELLO });

    expect(result.stopReason).toBe('reasoning_only');
    expect(result.text).toBe('');
    expect(result.thoughts).toContain('count the words');
  });

  it('takes the answer from the non-streaming return value, not only from chunks', async () => {
    // A model that thinks and then answers streams nothing through
    // `onTextChunk` for the thought part; `responseText` still has the answer.
    const { runtime } = await loadedRuntime({
      script: [{ responseText: 'hello tier two', thoughts: 'thinking hard' }],
    });

    const tokens: string[] = [];
    const result = await runtime.generate({
      requestId: 'r1',
      messages: HELLO,
      onToken: (token) => tokens.push(token),
    });

    expect(result.text).toBe('hello tier two');
    expect(result.stopReason).toBe('stop');
    expect(result.thoughts).toBe('thinking hard');
    expect(tokens.join('')).toBe('hello tier two');
  });

  it('turns Qwen thinking off by default and caps the thought budget', async () => {
    const { runtime, calls } = await loadedRuntime({ script: [{ responseText: 'ok' }] });

    await runtime.generate({ requestId: 'r1', messages: HELLO });

    expect(calls[0]?.wrapperName).toBe('Qwen');
    expect(calls[0]?.thoughts).toBe('discourage');
    expect(calls[0]?.thoughtBudget).toBe(0);
  });

  it('leaves the resolved wrapper alone when thinking is left on', async () => {
    const { runtime, calls } = await loadedRuntime({ script: [{ responseText: 'ok' }] });

    await runtime.generate({ requestId: 'r1', messages: HELLO, thinking: 'auto' });

    expect(calls[0]?.thoughtBudget).toBeUndefined();
  });

  it('maps the token limit onto a length stop reason', async () => {
    const { runtime } = await loadedRuntime({
      script: [{ responseText: 'truncated', stopReason: 'maxTokens' }],
    });

    const result = await runtime.generate({ requestId: 'r1', messages: HELLO });
    expect(result.stopReason).toBe('length');
  });

  it('refuses to generate once the model is unloaded', async () => {
    const { runtime } = await loadedRuntime({ script: [{ responseText: 'ok' }] });
    await runtime.unload();
    await expect(runtime.generate({ requestId: 'r1', messages: HELLO })).rejects.toThrow(
      'No model is loaded',
    );
  });
});
