import { describe, expect, it } from 'vitest';

import { MAX_PENDING_TOOL_CALLS, PendingToolCalls } from '../pending-tool-calls';

describe('PendingToolCalls', () => {
  it('parks and returns a proposal', () => {
    const store = new PendingToolCalls<string>();
    store.set('call-1', 'create_invoice');

    expect(store.get('call-1')).toBe('create_invoice');
    expect(store.size).toBe(1);

    expect(store.delete('call-1')).toBe(true);
    expect(store.get('call-1')).toBeUndefined();
  });

  it('evicts the oldest entry once the cap is reached', () => {
    const store = new PendingToolCalls<number>({ max: 3 });

    for (let index = 0; index < 10; index += 1) {
      store.set(`call-${index}`, index);
    }

    expect(store.size).toBe(3);
    // The three most recent survive; everything older is gone.
    expect(store.get('call-9')).toBe(9);
    expect(store.get('call-8')).toBe(8);
    expect(store.get('call-7')).toBe(7);
    expect(store.get('call-6')).toBeUndefined();
    expect(store.get('call-0')).toBeUndefined();
  });

  it('drops entries past their TTL', () => {
    let clock = 1_000;
    const store = new PendingToolCalls<string>({ ttlMs: 100, now: () => clock });

    store.set('old', 'a');
    clock += 101;
    store.set('fresh', 'b');

    expect(store.get('old')).toBeUndefined();
    expect(store.get('fresh')).toBe('b');
    expect(store.size).toBe(1);
  });

  it('stays bounded under a model that proposes without limit', () => {
    let clock = 0;
    const store = new PendingToolCalls<number>({ now: () => clock });

    // Nothing is ever approved or rejected, which is exactly the abandoned case.
    for (let index = 0; index < 5000; index += 1) {
      clock += 1;
      store.set(`call-${index}`, index);
      expect(store.size).toBeLessThanOrEqual(MAX_PENDING_TOOL_CALLS);
    }

    expect(store.size).toBe(MAX_PENDING_TOOL_CALLS);
  });

  it('clears everything on shutdown', () => {
    const store = new PendingToolCalls<string>();
    store.set('a', 'x');
    store.set('b', 'y');

    store.clear();
    expect(store.size).toBe(0);
  });
});
