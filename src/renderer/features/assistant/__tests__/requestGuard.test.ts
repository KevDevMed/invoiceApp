import { describe, expect, it } from 'vitest';

import {
  canDecide,
  canStartRequest,
  shouldAppendToken,
  shouldClearOnSettle,
  type ChatTokenEvent,
} from '../requestGuard';

function token(requestId: string, done = false): ChatTokenEvent {
  return { requestId, token: 'chunk', done };
}

describe('canStartRequest', () => {
  it('allows a request when nothing is in flight', () => {
    expect(canStartRequest(null)).toBe(true);
  });

  it('refuses a second send while a request is in flight', () => {
    expect(canStartRequest('req-1')).toBe(false);
  });
});

describe('shouldAppendToken', () => {
  it('appends a token for the active request', () => {
    expect(shouldAppendToken('req-1', token('req-1'))).toBe(true);
  });

  it('drops a token for a stale request id', () => {
    expect(shouldAppendToken('req-2', token('req-1'))).toBe(false);
  });

  it('drops a token when no request is active', () => {
    expect(shouldAppendToken(null, token('req-1'))).toBe(false);
  });

  it('drops the done marker even for the active request', () => {
    expect(shouldAppendToken('req-1', token('req-1', true))).toBe(false);
  });
});

describe('shouldClearOnSettle', () => {
  it('clears when the settling request is the active one', () => {
    expect(shouldClearOnSettle('req-1', 'req-1')).toBe(true);
  });

  it('does not let a stale request clear the active one', () => {
    expect(shouldClearOnSettle('req-2', 'req-1')).toBe(false);
  });

  it('does not clear when nothing is active', () => {
    expect(shouldClearOnSettle(null, 'req-1')).toBe(false);
  });
});

describe('canDecide', () => {
  it('allows a decision for a pending call while idle', () => {
    expect(canDecide(null, 'call-1', ['call-1', 'call-2'])).toBe(true);
  });

  it('refuses a decision while a request is streaming', () => {
    expect(canDecide('req-1', 'call-1', ['call-1'])).toBe(false);
  });

  it('refuses a decision for a call id absent from pendingApprovals', () => {
    expect(canDecide(null, 'call-gone', ['call-1'])).toBe(false);
  });

  it('refuses a decision when nothing is pending', () => {
    expect(canDecide(null, 'call-1', [])).toBe(false);
  });
});
