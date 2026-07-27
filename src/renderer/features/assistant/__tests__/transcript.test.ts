/**
 * The condition `AssistantPage` hands to `ChatLayout`.
 *
 * `ChatLayout` treats any non-null child as content, so the empty state only
 * appears when the parent passes `null`. These cases pin the rule that decides
 * it.
 */

import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../../../shared/types';
import { hasTranscriptContent, visibleMessages } from '../transcript';

function message(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: `${role}-${content}`,
    threadId: 'thread-1',
    role,
    content,
    toolCalls: null,
    createdAt: '2026-07-27T00:00:00.000Z',
  };
}

describe('visibleMessages', () => {
  it('drops system messages', () => {
    const messages = [
      message('system', 'You are a helpful assistant.'),
      message('user', 'Which invoices are overdue?'),
    ];
    expect(visibleMessages(messages).map((m) => m.role)).toEqual(['user']);
  });
});

describe('hasTranscriptContent', () => {
  it('is false for a brand new conversation', () => {
    expect(hasTranscriptContent([], false)).toBe(false);
  });

  it('is false when the only message is the system prompt', () => {
    expect(hasTranscriptContent([message('system', 'You are a helpful assistant.')], false)).toBe(
      false,
    );
  });

  it('is true once the user has said something', () => {
    expect(hasTranscriptContent([message('user', 'hello')], false)).toBe(true);
  });

  it('is true while streaming, before the first token', () => {
    expect(hasTranscriptContent([], true)).toBe(true);
  });
});
