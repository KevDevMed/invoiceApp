import { describe, expect, it } from 'vitest';

import { FakeLlmRuntime, NodeLlamaCppRuntime, shapePrompt } from '../runtime';

/**
 * The `NodeLlamaCppRuntime` half of this file needs a real GGUF on disk and
 * several seconds of CPU, so it is opt-in:
 *
 *   INVOICEAPP_SMOKE_GGUF=/path/to/model.gguf npx vitest run src/main/llm/__tests__/runtime.smoke.test.ts
 *
 * Everything above that gate runs everywhere.
 */

const GGUF_PATH = process.env.INVOICEAPP_SMOKE_GGUF;

describe('shapePrompt', () => {
  it('splits system turns out and takes the last user turn as the prompt', () => {
    const shaped = shapePrompt([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);

    expect(shaped.systemPrompt).toBe('You are terse.');
    expect(shaped.prompt).toBe('second');
    expect(shaped.history.map((turn) => turn.content)).toEqual(['first', 'reply']);
  });

  it('folds tool results into user turns, since no chat template has a tool role', () => {
    const shaped = shapePrompt([
      { role: 'user', content: 'how many?' },
      { role: 'assistant', content: 'checking' },
      { role: 'tool', content: '{"total":3}' },
    ]);

    expect(shaped.history.at(-1)).toEqual({ role: 'assistant', content: 'checking' });
    expect(shaped.prompt).toBe('Tool result:\n{"total":3}');
  });
});

describe('FakeLlmRuntime', () => {
  it('refuses to generate before a model is loaded', async () => {
    const runtime = new FakeLlmRuntime();
    await expect(
      runtime.generate({ requestId: 'r1', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow('No model is loaded');
  });

  it('streams tokens and reports a stop reason', async () => {
    const runtime = new FakeLlmRuntime({ reply: 'three word reply' });
    await runtime.load({ modelId: 'fake', modelPath: '/dev/null' });

    const tokens: string[] = [];
    const result = await runtime.generate({
      requestId: 'r2',
      messages: [{ role: 'user', content: 'hi' }],
      onToken: (token) => tokens.push(token),
    });

    expect(result.text).toBe('three word reply');
    expect(result.stopReason).toBe('stop');
    expect(tokens.join('')).toBe('three word reply');
  });

  it('stops mid-generation when the signal is aborted', async () => {
    const runtime = new FakeLlmRuntime({ reply: 'a b c d e f' });
    await runtime.load({ modelId: 'fake', modelPath: '/dev/null' });

    const controller = new AbortController();
    const result = await runtime.generate({
      requestId: 'r3',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      onToken: () => controller.abort(),
    });

    expect(result.stopReason).toBe('cancelled');
    expect(result.text.length).toBeLessThan('a b c d e f'.length);
  });

  it('unloads the resident model', async () => {
    const runtime = new FakeLlmRuntime();
    await runtime.load({ modelId: 'fake', modelPath: '/dev/null' });
    expect(runtime.current()?.modelId).toBe('fake');
    expect(await runtime.unload()).toBe(true);
    expect(runtime.current()).toBeNull();
    expect(await runtime.unload()).toBe(false);
  });
});

describe.skipIf(!GGUF_PATH)('NodeLlamaCppRuntime against a real GGUF', () => {
  it('loads the model and streams a real completion', { timeout: 600_000 }, async () => {
    const runtime = new NodeLlamaCppRuntime();
    const loaded = await runtime.load({
      modelId: 'smoke-model',
      modelPath: GGUF_PATH as string,
      contextSize: 1024,
    });
    expect(loaded.contextSize).toBeGreaterThan(0);

    const tokens: string[] = [];
    const result = await runtime.generate({
      requestId: 'smoke',
      messages: [
        { role: 'system', content: 'Answer in one short sentence.' },
        // Qwen3 reasons by default and node-llama-cpp strips thought segments
        // out of the response, so a small token budget can come back empty.
        // `/no_think` is Qwen3's own switch for that.
        { role: 'user', content: 'What is 2 + 2? /no_think' },
      ],
      temperature: 0,
      maxTokens: 128,
      onToken: (token) => tokens.push(token),
    });

    console.log(`[smoke] contextSize=${loaded.contextSize} tokens=${tokens.length}`);
    console.log(`[smoke] completion: ${result.text}`);

    expect(tokens.length).toBeGreaterThan(0);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.stopReason).toBe('stop');

    await runtime.dispose();
  });

  it(
    'holds a multi-turn conversation on one loaded model',
    { timeout: 1_800_000 },
    async () => {
      // The `No sequences left` regression, against the real backend: a context
      // is created with one sequence, so before the runtime owned the sequence
      // lifecycle the second turn here failed outright.
      const runtime = new NodeLlamaCppRuntime();
      await runtime.load({
        modelId: 'multi-turn',
        modelPath: GGUF_PATH as string,
        contextSize: 1024,
      });

      const turns = [
        'Reply with exactly three words: hello tier two',
        'Now reply with exactly two words: still here',
        'Now reply with exactly one word: done',
      ];
      const transcript: { role: 'user' | 'assistant'; content: string }[] = [];

      for (const [index, turn] of turns.entries()) {
        transcript.push({ role: 'user', content: turn });
        const reply = await runtime.generate({
          requestId: `multi-${index}`,
          messages: [{ role: 'system', content: 'Answer briefly.' }, ...transcript],
          temperature: 0,
          maxTokens: 32,
        });
        console.log(`[multi] turn ${index + 1} stop=${reply.stopReason} text=${reply.text.trim()}`);

        expect(reply.stopReason).not.toBe('error');
        expect(reply.text.trim().length).toBeGreaterThan(0);
        transcript.push({ role: 'assistant', content: reply.text });
      }

      // And a chat still works after one was cancelled.
      const controller = new AbortController();
      const cancelled = await runtime.generate({
        requestId: 'multi-cancel',
        messages: [{ role: 'user', content: 'Count to twenty slowly.' }],
        maxTokens: 64,
        signal: controller.signal,
        onToken: () => controller.abort(),
      });
      expect(cancelled.stopReason).toBe('cancelled');

      const after = await runtime.generate({
        requestId: 'multi-after-cancel',
        messages: [{ role: 'user', content: 'Reply with exactly one word: recovered' }],
        temperature: 0,
        maxTokens: 32,
      });
      console.log(`[multi] after cancel stop=${after.stopReason} text=${after.text.trim()}`);
      expect(after.text.trim().length).toBeGreaterThan(0);

      await runtime.dispose();
    },
  );
});
