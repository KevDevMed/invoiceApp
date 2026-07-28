import { describe, expect, it, vi } from 'vitest';

import { createSaveGuard } from '../saveGuard';

/**
 * Mirrors the ClientForm save flow: an async request settles and the
 * completion handlers (onSaved / error state writes) run through the guard.
 */
async function runGuardedSave(
  guard: ReturnType<typeof createSaveGuard>,
  request: Promise<string>,
  onSaved: (value: string) => void,
  onErrorState: (message: string) => void,
): Promise<void> {
  try {
    const saved = await request;
    guard.settle(() => {
      onSaved(saved);
    });
  } catch (cause) {
    guard.settle(() => {
      onErrorState(cause instanceof Error ? cause.message : String(cause));
    });
  }
}

describe('createSaveGuard', () => {
  it('accepts a response that arrives while the dialog is still open', async () => {
    const guard = createSaveGuard();
    const onSaved = vi.fn();
    const onErrorState = vi.fn();

    await runGuardedSave(guard, Promise.resolve('client-1'), onSaved, onErrorState);

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith('client-1');
    expect(onErrorState).not.toHaveBeenCalled();
  });

  it('ignores a response that arrives after the dialog was dismissed', async () => {
    const guard = createSaveGuard();
    const onSaved = vi.fn();
    const onErrorState = vi.fn();
    let resolve!: (value: string) => void;
    const request = new Promise<string>((r) => {
      resolve = r;
    });
    const flow = runGuardedSave(guard, request, onSaved, onErrorState);

    guard.dismiss();
    resolve('client-1');
    await flow;

    expect(onSaved).not.toHaveBeenCalled();
    expect(onErrorState).not.toHaveBeenCalled();
  });

  it('does not write error state for a rejection after dismissal', async () => {
    const guard = createSaveGuard();
    const onSaved = vi.fn();
    const onErrorState = vi.fn();
    let reject!: (cause: Error) => void;
    const request = new Promise<string>((_, r) => {
      reject = r;
    });
    const flow = runGuardedSave(guard, request, onSaved, onErrorState);

    guard.dismiss();
    reject(new Error('db locked'));
    await flow;

    expect(onSaved).not.toHaveBeenCalled();
    expect(onErrorState).not.toHaveBeenCalled();
  });

  it('still surfaces a rejection while the dialog is open', async () => {
    const guard = createSaveGuard();
    const onSaved = vi.fn();
    const onErrorState = vi.fn();

    await runGuardedSave(guard, Promise.reject(new Error('db locked')), onSaved, onErrorState);

    expect(onSaved).not.toHaveBeenCalled();
    expect(onErrorState).toHaveBeenCalledWith('db locked');
  });

  it('arm() re-arms a guard dismissed by a StrictMode-style remount', () => {
    const guard = createSaveGuard();
    guard.dismiss();
    expect(guard.isDismissed()).toBe(true);
    guard.arm();
    expect(guard.isDismissed()).toBe(false);
    const handler = vi.fn();
    guard.settle(handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
