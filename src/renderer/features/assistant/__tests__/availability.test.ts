/**
 * Pure tests for `availability.ts` — every branch of the decision table, the
 * DESKTOP_ONLY predicate against the exact shapes the preview produces, and
 * the copy for each state. No DOM, no React: the root vitest project runs in
 * node, which is why these decisions live outside the hook.
 */

import { describe, expect, it } from 'vitest';

import {
  assistantAvailability,
  availabilityCopy,
  isDesktopOnlyError,
  type AssistantAvailability,
} from '../availability';

const BASE = {
  isLoading: false,
  readyModelCount: 1,
  activeModelId: 'model-a',
  error: null,
  isDesktopOnlyError: false,
} as const;

describe('assistantAvailability', () => {
  it('is ready when a model is downloaded and selected', () => {
    expect(assistantAvailability(BASE)).toBe('ready');
  });

  it('is loading while the first refresh is in flight', () => {
    expect(assistantAvailability({ ...BASE, isLoading: true })).toBe('loading');
  });

  it('is no-model when nothing is downloaded', () => {
    expect(assistantAvailability({ ...BASE, readyModelCount: 0, activeModelId: null })).toBe(
      'no-model',
    );
  });

  it('is no-selection when models exist but none is chosen', () => {
    expect(assistantAvailability({ ...BASE, activeModelId: null })).toBe('no-selection');
  });

  it('is desktop-only when the host refused llm:*', () => {
    expect(
      assistantAvailability({
        ...BASE,
        readyModelCount: 0,
        activeModelId: null,
        isDesktopOnlyError: true,
      }),
    ).toBe('desktop-only');
  });

  /*
    Precedence: desktop-only beats loading. The platform cannot change while a
    spinner turns — once refused, "loading" would promise something that will
    never arrive.
  */
  it('prefers desktop-only over loading when both apply', () => {
    expect(
      assistantAvailability({ ...BASE, isLoading: true, isDesktopOnlyError: true }),
    ).toBe('desktop-only');
  });

  it('prefers loading over no-model: an in-flight refresh may still find models', () => {
    expect(
      assistantAvailability({ ...BASE, isLoading: true, readyModelCount: 0, activeModelId: null }),
    ).toBe('loading');
  });

  it('ignores a generic error string: a transient failure does not make the assistant unavailable', () => {
    expect(assistantAvailability({ ...BASE, error: 'the model crashed' })).toBe('ready');
  });
});

describe('isDesktopOnlyError', () => {
  /*
    `preview/web-shim.ts` rethrows the server's `{ ok: false, error: { code:
    'DESKTOP_ONLY', message } }` body as a `PreviewInvokeError` — an `Error`
    subclass carrying `code`. Reproduce that shape without importing preview
    code into a renderer test.
  */
  it('recognises an Error subclass carrying code DESKTOP_ONLY', () => {
    class PreviewInvokeError extends Error {
      constructor(
        readonly code: string,
        message: string,
      ) {
        super(message);
        this.name = 'PreviewInvokeError';
      }
    }
    const caught = new PreviewInvokeError(
      'DESKTOP_ONLY',
      'Local models are desktop-only. They run on the app’s native llama.cpp runtime, on your own machine.',
    );
    expect(isDesktopOnlyError(caught)).toBe(true);
  });

  it('recognises a plain object with code DESKTOP_ONLY', () => {
    expect(isDesktopOnlyError({ code: 'DESKTOP_ONLY', message: 'nope' })).toBe(true);
  });

  it('rejects other typed codes', () => {
    expect(isDesktopOnlyError({ code: 'INTERNAL', message: 'boom' })).toBe(false);
    expect(isDesktopOnlyError({ code: 'PREVIEW_UNREACHABLE', message: 'down' })).toBe(false);
  });

  it('rejects errors without a code', () => {
    expect(isDesktopOnlyError(new Error('DESKTOP_ONLY'))).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isDesktopOnlyError('DESKTOP_ONLY')).toBe(false);
    expect(isDesktopOnlyError(null)).toBe(false);
    expect(isDesktopOnlyError(undefined)).toBe(false);
  });
});

describe('availabilityCopy', () => {
  const STATES: readonly AssistantAvailability[] = [
    'loading',
    'desktop-only',
    'no-model',
    'no-selection',
    'ready',
  ];

  it.each(STATES)('returns non-empty title and description for %s', (state) => {
    const copy = availabilityCopy(state);
    expect(copy.title.length).toBeGreaterThan(0);
    expect(copy.description.length).toBeGreaterThan(0);
  });

  it('desktop-only copy names the platform that can run the assistant', () => {
    const copy = availabilityCopy('desktop-only');
    expect(copy.title).toContain('desktop');
    expect(copy.description).toContain('browser preview');
    expect(copy.description).toContain('locally on your machine');
  });
});
