/**
 * Every decision the floating assistant dock makes, as pure functions.
 *
 * `AssistantDock.tsx` is a React file the test runner cannot mount — the root
 * vitest project is `environment: 'node'` and there is no DOM harness. So the
 * rules that actually matter (is the dock on this route at all, which beam does
 * the launcher wear right now) live here, free of React and of the design
 * system, where a plain unit test can reach them. `./chrome.ts` exists for the
 * same reason and is the model this file follows.
 */

import type { ChatMessage } from '../../shared/types';
import type { AssistantAvailability } from '../features/assistant/availability';
import type { BeamPreset } from './beam/presets';

/**
 * The one route the dock stays off.
 *
 * Settings is where the user goes to change how the app behaves, including —
 * eventually — the assistant itself. A floating chat button hovering over its
 * own configuration is both visually noisy and circular, so the dock yields the
 * corner there. Everything else in the app gets it, including `/assistant`: the
 * page and the dock share one provider, so the launcher on that route is a
 * harmless no-op rather than a second, disagreeing chat.
 */
const HIDDEN_SECTION = '/settings';

/**
 * False on /settings, true everywhere else.
 *
 * The prefix check is the whole subtlety. `pathname.startsWith('/settings')`
 * would also swallow a future `/settings-export` route, which is a different
 * section that happens to share nine characters. `./chrome.ts` already solved
 * exactly this with `isSectionSelected` — match the path itself or anything
 * under a `/` boundary, never a bare string prefix — and this reuses that
 * semantics rather than inventing a second, subtly different one.
 *
 * The app runs on `HashRouter`, so `useLocation().pathname` is the part after
 * the `#` and always starts with `/`. The trailing-slash form (`/settings/`)
 * arrives via hand-typed URLs and is the same section; the empty string arrives
 * for a beat before the router's initial redirect resolves and is not.
 */
export function isDockVisible(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return !(normalized === HIDDEN_SECTION || normalized.startsWith(`${HIDDEN_SECTION}/`));
}

/** What the launcher needs to know to choose its beam. */
export interface LauncherBeamInput {
  /** Whether the chat panel is open. */
  readonly isOpen: boolean;
  /** Whether a reply is arriving right now. */
  readonly isStreaming: boolean;
  /** Mutating tool calls waiting on the user. */
  readonly pendingApprovalCount: number;
  /**
   * The assistant finished a message while the panel was shut. The dock owns
   * this flag locally and clears it on open — `useAssistant` has no concept of
   * "read", because the full-page route has no concept of "closed".
   */
  readonly hasUnreadReply: boolean;
}

/**
 * Which beam the launcher wears.
 *
 * Two rules, in order:
 *
 * 1. An open panel puts its own beam on the panel, so the launcher underneath
 *    it drops back to idle. Two competing animations six pixels apart read as a
 *    glitch, and the attention states exist to pull the user *into* a panel
 *    they are already looking at.
 * 2. Closed, anything the user has to answer or has not seen yet — a pending
 *    approval, an unread reply — raises the attention beam. A stream still in
 *    flight does not: nothing has arrived yet, so there is nothing to go and
 *    read. The unread flag lights up on its own when that stream finishes.
 */
export function launcherBeam(input: LauncherBeamInput): BeamPreset {
  if (input.isOpen) return 'launcher-idle';
  if (input.pendingApprovalCount > 0 || input.hasUnreadReply) return 'launcher-attention';
  return 'launcher-idle';
}

/**
 * Which beam the open panel wears. Streaming is the app's answer to "is it
 * stuck or is it thinking", so it outranks rest.
 */
export function panelBeam(isStreaming: boolean): BeamPreset {
  return isStreaming ? 'panel-streaming' : 'panel-idle';
}

/**
 * Whether the dock's composer refuses input right now.
 *
 * Two reasons, and they are different in kind:
 *
 * 1. `availability !== 'ready'` — there is nothing on the other end. The
 *    browser preview has no runtime, and a desktop app with no model chosen has
 *    nothing to send to. A composer that accepts text it can never answer lies.
 * 2. `isStreaming` — a reply is already in flight. The dock and the `/assistant`
 *    page share one provider and therefore one request slot, so two composers
 *    are live at once; letting either submit mid-stream races a single-slot
 *    lifecycle. Disabling here is the surface half of that guard (the hook
 *    enforces single-flight on its own side).
 *
 * The Stop button is deliberately *not* covered by this: `ChatComposer` keeps
 * it reachable via `isStopShown` while the input is disabled, so a user who
 * changes their mind mid-generation is never stuck waiting it out.
 *
 * Only `desktop-only` and `ready` actually reach a composer today — the other
 * three states render an empty state instead — but the rule is stated over the
 * whole union so a new branch cannot quietly acquire a live composer.
 */
export function isDockComposerDisabled(input: {
  readonly availability: AssistantAvailability;
  readonly isStreaming: boolean;
}): boolean {
  return input.availability !== 'ready' || input.isStreaming;
}

/** Id of the newest assistant reply in a transcript, or null if there is none. */
export function latestReplyId(messages: readonly ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.role === 'assistant') return message.id;
  }
  return null;
}

/**
 * How far the user has read, as of the last time the panel was open.
 *
 * The thread is part of the cursor, not decoration. Without it, switching
 * threads on the `/assistant` page — which the dock shares state with — would
 * swap in a transcript full of replies the cursor has never seen and light the
 * launcher for messages the user is, at that exact moment, looking at.
 */
export interface DockReadCursor {
  readonly threadId: string | null;
  readonly messageId: string | null;
}

/**
 * Whether a reply landed while the panel was shut.
 *
 * Expressed as a comparison against a cursor rather than as a "new message"
 * event, so it survives the panel being unmounted and remounted, and so it can
 * be tested here instead of in a DOM the runner does not have. The dock stamps
 * the cursor whenever the panel opens *or* closes; anything newer than the
 * stamp is by definition something the user has not seen.
 *
 * A cursor pointing at a different thread means "no opinion", not "unread".
 */
export function isReplyUnread(input: {
  readonly isOpen: boolean;
  readonly threadId: string | null;
  readonly latestReplyId: string | null;
  readonly cursor: DockReadCursor;
}): boolean {
  if (input.isOpen) return false;
  if (input.latestReplyId === null) return false;
  if (input.cursor.threadId !== input.threadId) return false;
  return input.cursor.messageId !== input.latestReplyId;
}
