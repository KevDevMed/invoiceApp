/**
 * Which messages the transcript actually draws, and whether there are any.
 *
 * This lives outside `index.tsx` for one reason: `ChatLayout` only swaps in its
 * `emptyState` when the children it is handed are literally `null`. A component
 * that renders `null` internally is still a non-null element, so the decision
 * has to be made by the parent, before the element exists. Keeping the rule in a
 * plain module also makes it testable without a DOM.
 */

import type { ChatMessage } from '../../../shared/types';

/** System messages are prompt plumbing, never shown in the thread. */
export function visibleMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role !== 'system');
}

/**
 * True when the chat surface has something to draw. A stream in flight counts
 * even before its first token, because the transcript shows a "Thinking…" row.
 */
export function hasTranscriptContent(
  messages: readonly ChatMessage[],
  isStreaming: boolean,
): boolean {
  return isStreaming || visibleMessages(messages).length > 0;
}
