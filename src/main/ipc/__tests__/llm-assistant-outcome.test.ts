/**
 * What the chat handler persists as the assistant turn.
 *
 * The runtime defect behind these: a reasoning model returns thought segments
 * and no text, and the handler stored `content: ""` as if it were a reply, so
 * the user saw a blank message.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type * as LlmHandlers from '../llm';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/invoiceapp-test', getGPUInfo: async () => ({}) },
  ipcMain: { handle: () => undefined },
}));

let llm: typeof LlmHandlers;

describe('resolveAssistantOutcome', () => {
  beforeAll(async () => {
    process.env.INVOICEAPP_FAKE_LLM = '1';
    llm = await import('../llm');
  });

  it('keeps a normal completion exactly as generated', () => {
    const outcome = llm.resolveAssistantOutcome({
      text: 'hello tier two',
      stopReason: 'stop',
      hasToolCalls: false,
    });

    expect(outcome.content).toBe('hello tier two');
    expect(outcome.stopReason).toBe('stop');
  });

  it('keeps the text of a turn that also carried tool calls', () => {
    const outcome = llm.resolveAssistantOutcome({
      text: '{"tool_call":{"name":"list_clients"}}',
      stopReason: 'stop',
      hasToolCalls: true,
    });

    expect(outcome.content).toBe('{"tool_call":{"name":"list_clients"}}');
    expect(outcome.stopReason).toBe('stop');
  });

  it('never stores an empty reply for a reasoning-only turn', () => {
    const outcome = llm.resolveAssistantOutcome({
      text: '',
      stopReason: 'reasoning_only',
      thoughts: 'The user asked for three words...',
      hasToolCalls: false,
    });

    expect(outcome.content).toBe(llm.REASONING_ONLY_NOTICE);
    expect(outcome.content).not.toBe('');
    // The contract has four stop reasons, so this one travels as `error` —
    // which is the value the Assistant page raises a banner for.
    expect(outcome.stopReason).toBe('error');
  });

  it('treats an empty answer with thoughts as reasoning-only even on a plain stop', () => {
    const outcome = llm.resolveAssistantOutcome({
      text: '   ',
      stopReason: 'stop',
      thoughts: 'thinking',
      hasToolCalls: false,
    });

    expect(outcome.content).toBe(llm.REASONING_ONLY_NOTICE);
    expect(outcome.stopReason).toBe('error');
  });

  it('says why an empty turn was empty for every other stop reason', () => {
    const cancelled = llm.resolveAssistantOutcome({
      text: '',
      stopReason: 'cancelled',
      hasToolCalls: false,
    });
    expect(cancelled.content.length).toBeGreaterThan(0);
    expect(cancelled.stopReason).toBe('cancelled');

    const length = llm.resolveAssistantOutcome({
      text: '',
      stopReason: 'length',
      hasToolCalls: false,
    });
    expect(length.content).toContain('token limit');
    expect(length.stopReason).toBe('length');

    const empty = llm.resolveAssistantOutcome({ text: '', stopReason: 'stop', hasToolCalls: false });
    expect(empty.content.length).toBeGreaterThan(0);
    expect(empty.stopReason).toBe('error');
  });

  it('describes a pending approval that arrived with no prose', () => {
    const outcome = llm.resolveAssistantOutcome({
      text: '',
      stopReason: 'stop',
      hasToolCalls: true,
    });

    expect(outcome.content).toContain('decision');
    expect(outcome.stopReason).toBe('stop');
  });
});
