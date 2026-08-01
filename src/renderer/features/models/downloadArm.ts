/**
 * The arm behind `Download & use`.
 *
 * `llm:download` returns when the transfer *starts*, and the load has to happen
 * when it *finishes*, so the second half of that button is armed here and fired
 * from the progress stream. Two things make a bare `Set` of model ids wrong:
 *
 *   - **the terminal event can beat the invoke.** A small or already-cached file
 *     reports `ready` before `llm:download` resolves. A set armed after the
 *     invoke misses the event, then keeps the id for ever — and the next plain
 *     `Download` of that model trips over the leftover arm and loads it. A plain
 *     `Download` must never load a model.
 *   - **an arm belongs to one request, not to a model id.** Without a token
 *     there is no way to tell this request's terminal event from a later one's.
 *
 * So an arm is created *before* the invoke, carries a token, is matched to its
 * model id when the invoke resolves, and is cleared by any terminal event, by a
 * failed invoke, and by a plain download of the same file.
 *
 * State is a plain value with pure transitions. The hook keeps it in a ref; the
 * clock is passed in, because there is no DOM harness in this repo and a module
 * that reads `Date.now()` itself cannot be tested here.
 */

/** A transfer's last word. `paused` arrives as `cancelled` on this channel. */
export type TerminalStatus = 'ready' | 'error' | 'cancelled';

interface PendingArm {
  /** `repo/filename` — what the button was pressed on, before an id exists. */
  readonly key: string;
  readonly startedAt: number;
}

interface ActiveArm {
  readonly token: number;
  readonly key: string;
}

export interface ArmState {
  readonly nextToken: number;
  /** Armed requests that have a model id: `modelId` → arm. */
  readonly arms: ReadonlyMap<string, ActiveArm>;
  /** Armed requests still waiting for one: `token` → arm. */
  readonly pending: ReadonlyMap<number, PendingArm>;
  /** Terminal events seen recently, so one that beat its invoke is not lost. */
  readonly terminals: ReadonlyMap<string, { readonly status: TerminalStatus; readonly at: number }>;
}

/** How long a terminal event is worth remembering for an invoke still in flight. */
const TERMINAL_MEMORY_MS = 60_000;

export function emptyArmState(): ArmState {
  return { nextToken: 1, arms: new Map(), pending: new Map(), terminals: new Map() };
}

/** Drop every arm for one `repo/filename`, whether or not it has an id yet. */
export function disarmKey(state: ArmState, key: string): ArmState {
  const arms = new Map(state.arms);
  for (const [modelId, arm] of arms) {
    if (arm.key === key) arms.delete(modelId);
  }
  const pending = new Map(state.pending);
  for (const [token, arm] of pending) {
    if (arm.key === key) pending.delete(token);
  }
  return { ...state, arms, pending };
}

/**
 * Arm a `Download & use` before its invoke goes out.
 *
 * Any earlier arm on the same file is superseded — pressing the button twice
 * asks for one load, not two, and the older request's id may never arrive.
 */
export function armUse(state: ArmState, key: string, now: number): {
  readonly state: ArmState;
  readonly token: number;
} {
  const cleared = disarmKey(state, key);
  const token = cleared.nextToken;
  const pending = new Map(cleared.pending);
  pending.set(token, { key, startedAt: now });
  return { state: { ...cleared, nextToken: token + 1, pending }, token };
}

/** The invoke threw: nothing was started, so nothing stays armed. */
export function cancelArm(state: ArmState, token: number): ArmState {
  if (!state.pending.has(token)) return state;
  const pending = new Map(state.pending);
  pending.delete(token);
  return { ...state, pending };
}

/**
 * The invoke resolved and the request finally has a model id.
 *
 * If a terminal event for that id already arrived after this arm was created,
 * it *was* this request's — consume it now rather than waiting for a second one
 * that is never coming. `shouldLoad` is true only for `ready`.
 *
 * `now` is the same clock `noteTerminal` stamps with, and it is what enforces
 * `TERMINAL_MEMORY_MS` on this side. Without it the TTL was written down but
 * never applied on attach: only the *next* terminal event pruned the map, so a
 * download whose invoke took longer than a minute to resolve could consume a
 * terminal that had already aged out of the window it was kept for.
 */
export function attachModelId(
  state: ArmState,
  token: number,
  modelId: string,
  now: number,
): { readonly state: ArmState; readonly shouldLoad: boolean } {
  const arm = state.pending.get(token);
  if (!arm) return { state, shouldLoad: false };

  const pending = new Map(state.pending);
  pending.delete(token);

  const seen = state.terminals.get(modelId);
  if (seen && seen.at >= arm.startedAt) {
    const terminals = new Map(state.terminals);
    terminals.delete(modelId);
    // Inside the window it is this request's last word. Outside it, the request
    // is simply over: the transfer already ended, so no second terminal event is
    // coming, and arming the id anyway would leave a dangling arm for the next
    // plain `Download` of that model to trip over.
    const fresh = now - seen.at <= TERMINAL_MEMORY_MS;
    return {
      state: { ...state, pending, terminals },
      shouldLoad: fresh && seen.status === 'ready',
    };
  }

  const arms = new Map(state.arms);
  arms.set(modelId, { token, key: arm.key });
  return { state: { ...state, pending, arms }, shouldLoad: false };
}

/**
 * A transfer said its last word.
 *
 * Any arm on that id is spent either way — only a transfer that actually
 * finished earns the load, and error, cancelled and paused all disarm it. The
 * event is remembered briefly in case it beat an invoke that is still in flight.
 */
export function noteTerminal(
  state: ArmState,
  modelId: string,
  status: TerminalStatus,
  now: number,
): { readonly state: ArmState; readonly shouldLoad: boolean } {
  const shouldLoad = state.arms.has(modelId) && status === 'ready';

  const arms = new Map(state.arms);
  arms.delete(modelId);

  const terminals = new Map(state.terminals);
  for (const [id, record] of terminals) {
    if (now - record.at > TERMINAL_MEMORY_MS) terminals.delete(id);
  }
  // Only worth remembering while some request is still waiting for its id.
  if (state.pending.size > 0) terminals.set(modelId, { status, at: now });

  return { state: { ...state, arms, terminals }, shouldLoad };
}
