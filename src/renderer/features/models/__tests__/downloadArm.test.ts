import { describe, expect, it } from 'vitest';

import {
  armUse,
  attachModelId,
  cancelArm,
  disarmKey,
  emptyArmState,
  noteTerminal,
} from '../downloadArm';

const KEY = 'a/Foo-GGUF/foo.gguf';
const OTHER = 'b/Bar-GGUF/bar.gguf';
const ID = 'model-1';

describe('downloadArm', () => {
  it('loads once the transfer it armed reports ready', () => {
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const attached = attachModelId(armed.state, armed.token, ID, 1_500);
    expect(attached.shouldLoad).toBe(false);

    const terminal = noteTerminal(attached.state, ID, 'ready', 2_000);
    expect(terminal.shouldLoad).toBe(true);
  });

  it('loads when the terminal event beat the invoke it was armed for', () => {
    // The whole reason the arm is created before the invoke: a cached or tiny
    // file reports `ready` while `llm:download` is still resolving.
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const early = noteTerminal(armed.state, ID, 'ready', 1_100);
    expect(early.shouldLoad).toBe(false);

    const attached = attachModelId(early.state, armed.token, ID, 1_500);
    expect(attached.shouldLoad).toBe(true);
  });

  it('does not load when the event that beat the invoke was not a success', () => {
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const early = noteTerminal(armed.state, ID, 'error', 1_100);
    expect(attachModelId(early.state, armed.token, ID, 1_500).shouldLoad).toBe(false);
  });

  it('leaves nothing behind for a later plain download to trip over', () => {
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const early = noteTerminal(armed.state, ID, 'ready', 1_100);
    const attached = attachModelId(early.state, armed.token, ID, 1_500);
    expect(attached.shouldLoad).toBe(true);

    // A plain `Download` of the same model, later. It must never load.
    const again = noteTerminal(attached.state, ID, 'ready', 9_000);
    expect(again.shouldLoad).toBe(false);
  });

  it('ignores a terminal event that predates the arm', () => {
    const before = noteTerminal(
      { ...emptyArmState(), pending: new Map([[99, { key: OTHER, startedAt: 0 }]]) },
      ID,
      'ready',
      500,
    );
    const armed = armUse(before.state, KEY, 1_000);
    expect(attachModelId(armed.state, armed.token, ID, 1_500).shouldLoad).toBe(false);
  });

  it('disarms on error, cancel and pause — only a finished transfer earns the load', () => {
    for (const status of ['error', 'cancelled'] as const) {
      const armed = armUse(emptyArmState(), KEY, 1_000);
      const attached = attachModelId(armed.state, armed.token, ID, 1_500);
      const terminal = noteTerminal(attached.state, ID, status, 2_000);
      expect(terminal.shouldLoad).toBe(false);
      // And the arm is spent: a later success does not resurrect it.
      expect(noteTerminal(terminal.state, ID, 'ready', 3_000).shouldLoad).toBe(false);
    }
  });

  it('revokes an arm when the same file is plainly downloaded instead', () => {
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const attached = attachModelId(armed.state, armed.token, ID, 1_500);

    const plain = disarmKey(attached.state, KEY);
    expect(noteTerminal(plain, ID, 'ready', 2_000).shouldLoad).toBe(false);
  });

  it('revokes an arm that never got its model id when the file is plainly downloaded', () => {
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const plain = disarmKey(armed.state, KEY);
    expect(attachModelId(plain, armed.token, ID, 1_500).shouldLoad).toBe(false);
    expect(noteTerminal(attachModelId(plain, armed.token, ID, 1_500).state, ID, 'ready', 2_000).shouldLoad).toBe(
      false,
    );
  });

  it('leaves an arm on a different file alone', () => {
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const attached = attachModelId(armed.state, armed.token, ID, 1_500);
    const plain = disarmKey(attached.state, OTHER);
    expect(noteTerminal(plain, ID, 'ready', 2_000).shouldLoad).toBe(true);
  });

  it('arms nothing when the invoke threw', () => {
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const cancelled = cancelArm(armed.state, armed.token);
    expect(attachModelId(cancelled, armed.token, ID, 1_500).shouldLoad).toBe(false);
    expect(noteTerminal(cancelled, ID, 'ready', 2_000).shouldLoad).toBe(false);
  });

  it('supersedes an earlier arm on the same file rather than loading twice', () => {
    const first = armUse(emptyArmState(), KEY, 1_000);
    const second = armUse(first.state, KEY, 1_100);
    expect(attachModelId(second.state, first.token, ID, 1_500).shouldLoad).toBe(false);

    const attached = attachModelId(second.state, second.token, ID, 1_500);
    expect(noteTerminal(attached.state, ID, 'ready', 2_000).shouldLoad).toBe(true);
  });

  it('refuses a terminal event that has aged past the window it was kept for', () => {
    // The invoke took longer than the TTL to resolve. The remembered event is
    // no longer evidence about *this* request, so it is not consumed as one.
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const early = noteTerminal(armed.state, ID, 'ready', 1_100);

    const attached = attachModelId(early.state, armed.token, ID, 1_100 + 60_001);
    expect(attached.shouldLoad).toBe(false);
  });

  it('honours a terminal event on the last millisecond of the window', () => {
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const early = noteTerminal(armed.state, ID, 'ready', 1_100);

    expect(attachModelId(early.state, armed.token, ID, 1_100 + 60_000).shouldLoad).toBe(true);
  });

  it('leaves no arm behind when it refuses an expired terminal event', () => {
    // The transfer already ended, so no second terminal event is coming for it.
    // Arming the id anyway would leave a dangling arm for the next *plain*
    // download of that model to trip over — and a plain download never loads.
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const early = noteTerminal(armed.state, ID, 'ready', 1_100);
    const attached = attachModelId(early.state, armed.token, ID, 1_100 + 60_001);

    expect(attached.state.arms.has(ID)).toBe(false);
    expect(attached.state.terminals.has(ID)).toBe(false);
    expect(noteTerminal(attached.state, ID, 'ready', 200_000).shouldLoad).toBe(false);
  });

  it('forgets a remembered terminal event once it is too old to belong to anyone', () => {
    const armed = armUse(emptyArmState(), KEY, 1_000);
    const stale = noteTerminal(armed.state, ID, 'ready', 1_100);
    // A minute later some other transfer ends; the old record ages out.
    const later = noteTerminal(stale.state, 'model-2', 'error', 200_000);
    expect(later.state.terminals.has(ID)).toBe(false);
  });
});
