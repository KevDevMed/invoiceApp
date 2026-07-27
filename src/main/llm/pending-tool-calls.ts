/**
 * The parking area for mutating tool calls waiting on a human.
 *
 * A model can propose a mutating tool call on every turn, and the user is under
 * no obligation to ever click Approve or Reject. Parking those proposals in a
 * plain `Map` keyed by call id means model output drives unbounded growth for
 * the life of the process, which is the part that matters — the entries are
 * small, but nothing ever removes them.
 *
 * So the store is bounded twice over: an entry older than the TTL is dropped,
 * and when the map is still at its cap the oldest entry goes. Insertion order is
 * `Map` order, so "oldest" needs no extra bookkeeping.
 *
 * Losing a parked call is safe: `applyIncomingMessage` already handles a
 * decision that refers to a call it cannot find, and answers UNKNOWN_TOOL_CALL.
 * Nothing is executed on an evicted proposal.
 */

/** Proposals older than this are assumed abandoned. */
export const PENDING_TOOL_CALL_TTL_MS = 30 * 60 * 1000;

/** Hard cap, whatever the TTL says. */
export const MAX_PENDING_TOOL_CALLS = 32;

interface Parked<T> {
  readonly value: T;
  readonly at: number;
}

export interface PendingToolCallsOptions {
  readonly ttlMs?: number;
  readonly max?: number;
  readonly now?: () => number;
}

export class PendingToolCalls<T> {
  private readonly entries = new Map<string, Parked<T>>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(options: PendingToolCallsOptions = {}) {
    this.ttlMs = options.ttlMs ?? PENDING_TOOL_CALL_TTL_MS;
    this.max = Math.max(1, options.max ?? MAX_PENDING_TOOL_CALLS);
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    this.expire();
    return this.entries.size;
  }

  set(id: string, value: T): void {
    this.expire();
    this.entries.delete(id);
    this.entries.set(id, { value, at: this.now() });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get(id: string): T | undefined {
    this.expire();
    return this.entries.get(id)?.value;
  }

  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Drop everything past its TTL. Called on every access; there is no timer. */
  private expire(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, parked] of this.entries) {
      // Insertion order is age order, so the first live entry ends the sweep.
      if (parked.at > cutoff) break;
      this.entries.delete(id);
    }
  }
}
