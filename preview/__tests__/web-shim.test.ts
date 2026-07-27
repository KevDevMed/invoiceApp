/**
 * The browser shim's contract with the renderer.
 *
 * The renderer was written against the preload, so these assert the two things
 * it actually depends on: the channel allow-list, and `on()` handing back an
 * unsubscribe that React's effect cleanup can call safely.
 */

import { describe, expect, it, vi } from 'vitest';

import { EVENT_CHANNELS } from '../../src/shared/ipc-contract';
import { listenerCount, previewApi } from '../web-shim';

describe('window.api.on', () => {
  it('returns a callable unsubscribe for every event channel', () => {
    for (const channel of EVENT_CHANNELS) {
      const unsubscribe = previewApi.on(channel, () => {});
      expect(typeof unsubscribe, channel).toBe('function');
      expect(() => unsubscribe()).not.toThrow();
    }
  });

  it('actually unsubscribes, and tolerates being called twice', () => {
    const listener = vi.fn();
    const before = listenerCount('llm:downloadProgress');

    const unsubscribe = previewApi.on('llm:downloadProgress', listener);
    expect(listenerCount('llm:downloadProgress')).toBe(before + 1);

    unsubscribe();
    expect(listenerCount('llm:downloadProgress')).toBe(before);

    // React can run cleanup more than once; this must not throw or go negative.
    expect(() => unsubscribe()).not.toThrow();
    expect(listenerCount('llm:downloadProgress')).toBe(before);
  });

  it('never fires — the preview has no main process to emit events', async () => {
    const listener = vi.fn();
    const unsubscribe = previewApi.on('llm:chatToken', listener);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('refuses an undeclared event channel, like the preload does', () => {
    expect(() =>
      (previewApi.on as unknown as (channel: string, listener: () => void) => void)(
        'llm:secretStream',
        () => {},
      ),
    ).toThrow(/undeclared channel/);
  });
});

describe('window.api.invoke', () => {
  it('rejects an undeclared channel before any request leaves the page', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      (previewApi.invoke as unknown as (channel: string, payload: unknown) => Promise<unknown>)(
        'clients:truncate',
        {},
      ),
    ).rejects.toThrow(/Blocked IPC invoke on undeclared channel: clients:truncate/);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('rejects with an Error carrying the server message, like the preload path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: 'DESKTOP_ONLY', message: 'PDF export is desktop-only.' },
        }),
        { status: 501, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(previewApi.invoke('invoices:exportPdf', { id: 'x' })).rejects.toThrow(
      'PDF export is desktop-only.',
    );

    fetchSpy.mockRestore();
  });

  it('resolves with the data envelope unwrapped', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { key: 'ui.themeMode', value: 'dark' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(previewApi.invoke('settings:get', { key: 'ui.themeMode' })).resolves.toEqual({
      key: 'ui.themeMode',
      value: 'dark',
    });

    fetchSpy.mockRestore();
  });
});
