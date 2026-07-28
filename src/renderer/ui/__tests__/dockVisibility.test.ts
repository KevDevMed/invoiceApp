import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../../../shared/types';
import { SECTION_ROUTES } from '../../chrome';
import {
  isDockVisible,
  isReplyUnread,
  latestReplyId,
  launcherBeam,
  panelBeam,
} from '../dockVisibility';

describe('isDockVisible', () => {
  it('hides the dock on /settings', () => {
    expect(isDockVisible('/settings')).toBe(false);
  });

  it('hides the dock on the trailing-slash form of /settings', () => {
    expect(isDockVisible('/settings/')).toBe(false);
  });

  it('hides the dock on anything nested under /settings', () => {
    expect(isDockVisible('/settings/appearance')).toBe(false);
    expect(isDockVisible('/settings/appearance/advanced')).toBe(false);
  });

  it('shows the dock on a route that merely starts with the same letters', () => {
    // The trap `startsWith('/settings')` falls into: a different section.
    expect(isDockVisible('/settings-export')).toBe(true);
    expect(isDockVisible('/settingsomething/deep')).toBe(true);
  });

  it('shows the dock on every section route except /settings', () => {
    for (const route of SECTION_ROUTES) {
      expect(isDockVisible(route.path)).toBe(route.path !== '/settings');
    }
  });

  it('shows the dock on nested paths under a visible section', () => {
    expect(isDockVisible('/invoices/new')).toBe(true);
    expect(isDockVisible('/invoices/inv-2026-004/edit')).toBe(true);
    expect(isDockVisible('/clients/')).toBe(true);
  });

  it('shows the dock for the empty pathname the router reports before its first redirect', () => {
    expect(isDockVisible('')).toBe(true);
  });

  it('shows the dock at the root', () => {
    expect(isDockVisible('/')).toBe(true);
  });

  it('shows the dock on an unknown route', () => {
    expect(isDockVisible('/nope')).toBe(true);
  });
});

describe('launcherBeam', () => {
  const base = {
    isOpen: false,
    isStreaming: false,
    pendingApprovalCount: 0,
    hasUnreadReply: false,
  };

  it('is idle when closed with nothing to report', () => {
    expect(launcherBeam(base)).toBe('launcher-idle');
  });

  it('asks for attention when closed with a pending approval', () => {
    expect(launcherBeam({ ...base, pendingApprovalCount: 1 })).toBe('launcher-attention');
  });

  it('asks for attention when closed with an unread reply', () => {
    expect(launcherBeam({ ...base, hasUnreadReply: true })).toBe('launcher-attention');
  });

  it('asks for attention when closed with both', () => {
    expect(launcherBeam({ ...base, pendingApprovalCount: 2, hasUnreadReply: true })).toBe(
      'launcher-attention',
    );
  });

  it('stays idle while a closed panel is still streaming, because nothing has arrived yet', () => {
    expect(launcherBeam({ ...base, isStreaming: true })).toBe('launcher-idle');
  });

  it('still asks for attention while streaming if an approval is already pending', () => {
    expect(launcherBeam({ ...base, isStreaming: true, pendingApprovalCount: 1 })).toBe(
      'launcher-attention',
    );
  });

  it('drops back to idle whenever the panel is open, so it never fights the panel beam', () => {
    expect(launcherBeam({ ...base, isOpen: true })).toBe('launcher-idle');
    expect(launcherBeam({ ...base, isOpen: true, isStreaming: true })).toBe('launcher-idle');
    expect(launcherBeam({ ...base, isOpen: true, pendingApprovalCount: 3 })).toBe('launcher-idle');
    expect(launcherBeam({ ...base, isOpen: true, hasUnreadReply: true })).toBe('launcher-idle');
  });
});

describe('panelBeam', () => {
  it('is loud while streaming', () => {
    expect(panelBeam(true)).toBe('panel-streaming');
  });

  it('is a hairline at rest', () => {
    expect(panelBeam(false)).toBe('panel-idle');
  });
});

function message(id: string, role: ChatMessage['role']): ChatMessage {
  return {
    id,
    threadId: 't1',
    role,
    content: 'x',
    toolCalls: null,
    createdAt: '2026-07-28T10:00:00.000Z',
  };
}

describe('latestReplyId', () => {
  it('is null for an empty transcript', () => {
    expect(latestReplyId([])).toBeNull();
  });

  it('is null when the assistant has not spoken yet', () => {
    expect(latestReplyId([message('m1', 'system'), message('m2', 'user')])).toBeNull();
  });

  it('is the newest assistant message, ignoring later user and tool turns', () => {
    expect(
      latestReplyId([
        message('m1', 'user'),
        message('m2', 'assistant'),
        message('m3', 'assistant'),
        message('m4', 'tool'),
        message('m5', 'user'),
      ]),
    ).toBe('m3');
  });
});

describe('isReplyUnread', () => {
  const cursor = { threadId: 't1', messageId: 'm2' };

  it('is never unread while the panel is open', () => {
    expect(isReplyUnread({ isOpen: true, threadId: 't1', latestReplyId: 'm9', cursor })).toBe(false);
  });

  it('is unread when a newer reply arrived in the same thread', () => {
    expect(isReplyUnread({ isOpen: false, threadId: 't1', latestReplyId: 'm9', cursor })).toBe(true);
  });

  it('is read when the cursor already points at the newest reply', () => {
    expect(isReplyUnread({ isOpen: false, threadId: 't1', latestReplyId: 'm2', cursor })).toBe(
      false,
    );
  });

  it('has no opinion when the cursor belongs to a different thread', () => {
    // Switching threads on the /assistant page swaps in replies the user is
    // looking at right now; lighting the launcher for them would be a lie.
    expect(isReplyUnread({ isOpen: false, threadId: 't2', latestReplyId: 'm9', cursor })).toBe(
      false,
    );
  });

  it('has no opinion before the assistant has replied at all', () => {
    expect(isReplyUnread({ isOpen: false, threadId: 't1', latestReplyId: null, cursor })).toBe(
      false,
    );
  });

  it('is unread on a fresh thread once the first reply lands', () => {
    expect(
      isReplyUnread({
        isOpen: false,
        threadId: null,
        latestReplyId: 'm1',
        cursor: { threadId: null, messageId: null },
      }),
    ).toBe(true);
  });
});
