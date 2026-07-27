/**
 * `registry.ts` collects an optional `shutdown` export from every handler module
 * and drains it on `before-quit`, before the database closes. This module used to
 * export `shutdownLlm` under a name nothing looked for, so the teardown never ran.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type * as LlmHandlers from '../llm';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '/tmp/invoiceapp-test', getGPUInfo: async () => ({}) },
  ipcMain: { handle: () => undefined },
}));

let llm: typeof LlmHandlers;

describe('llm handler module shutdown', () => {
  beforeAll(async () => {
    // The double runtime, so no native addon is loaded by this test.
    process.env.INVOICEAPP_FAKE_LLM = '1';
    llm = await import('../llm');
  });

  it('exports the name the registry looks for', () => {
    expect(typeof llm.shutdown).toBe('function');
  });

  it('drains the teardown without throwing when nothing is in flight', async () => {
    await expect(llm.shutdown()).resolves.toBeUndefined();
  });
});
