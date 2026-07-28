/**
 * Single-flight decisions for the assistant's chat request lifecycle.
 *
 * `useAssistant` tracks the in-flight request in a ref (synchronous, unlike
 * React state) and asks these functions before acting. They are pure so the
 * node-only vitest project can exercise every branch without mounting React.
 *
 * The invariant they enforce: at most one `llm:chat` request exists at a time,
 * and only that request may append tokens, clear busy state, or be stopped.
 * Without it, the first request to finish flips `isStreaming` to false while a
 * second still runs — which re-enables the tool-call Approve buttons during
 * live generation.
 */

export interface ChatTokenEvent {
  readonly requestId: string;
  readonly token: string;
  readonly done: boolean;
}

/** May a new request start while `activeRequestId` is in flight? */
export function canStartRequest(activeRequestId: string | null): boolean {
  return activeRequestId === null;
}

/** Should this streamed token be appended to the visible streaming text? */
export function shouldAppendToken(
  activeRequestId: string | null,
  event: ChatTokenEvent,
): boolean {
  return !event.done && activeRequestId !== null && event.requestId === activeRequestId;
}

/** When request `settledRequestId` settles, may it clear the busy state? */
export function shouldClearOnSettle(
  activeRequestId: string | null,
  settledRequestId: string,
): boolean {
  return activeRequestId === settledRequestId;
}

/** May an approve/reject decision for `callId` be sent right now? */
export function canDecide(
  activeRequestId: string | null,
  callId: string,
  pendingCallIds: readonly string[],
): boolean {
  // A decision is only actionable while nothing is generating AND the call is
  // still awaiting an answer — a stale or replayed id must be a no-op.
  return activeRequestId === null && pendingCallIds.includes(callId);
}
