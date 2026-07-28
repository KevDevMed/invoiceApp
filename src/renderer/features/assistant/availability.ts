/**
 * Availability of the assistant, decided by pure functions.
 *
 * The assistant can be unusable for very different reasons — the browser
 * preview has no llama.cpp runtime at all, or the desktop app simply has no
 * model downloaded yet — and the UI must say which, honestly. The root vitest
 * project runs in a node environment with no DOM harness, so every one of
 * these decisions lives here, React-free, where a plain unit test can reach
 * it. `useAssistant` feeds this module its state; components only render the
 * verdict.
 *
 * The DESKTOP_ONLY shape matched here comes from `preview/handlers.ts`: every
 * `llm:*` channel in the preview answers `{ ok: false, error: { code:
 * 'DESKTOP_ONLY', message } }`, which `preview/web-shim.ts` rethrows as a
 * `PreviewInvokeError` carrying that `code` property. We match the `code`
 * structurally rather than importing the class — the renderer must not depend
 * on preview-only modules.
 */

export type AssistantAvailability =
  | 'loading'
  | 'desktop-only' // llm:* refused by the host (browser preview)
  | 'no-model' // desktop, but nothing downloaded
  | 'no-selection' // models exist, none chosen
  | 'ready';

/** True when a caught error is the preview's typed `DESKTOP_ONLY` refusal. */
export function isDesktopOnlyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'DESKTOP_ONLY'
  );
}

/**
 * Precedence, highest first: desktop-only, loading, no-model, no-selection,
 * ready. Desktop-only beats loading because the platform cannot change while
 * a spinner turns — once the host has refused an `llm:*` call, waiting longer
 * will never help, and showing "loading" would promise something that cannot
 * arrive. A generic `error` string deliberately does not gate availability:
 * a transient chat failure still leaves the assistant available, and the
 * page's error banner reports it separately.
 */
export function assistantAvailability(input: {
  readonly isLoading: boolean;
  readonly readyModelCount: number;
  readonly activeModelId: string | null;
  readonly error: string | null;
  readonly isDesktopOnlyError: boolean;
}): AssistantAvailability {
  if (input.isDesktopOnlyError) return 'desktop-only';
  if (input.isLoading) return 'loading';
  if (input.readyModelCount === 0) return 'no-model';
  if (input.activeModelId === null) return 'no-selection';
  return 'ready';
}

/** Copy for each state. Never blames the user; says which platform can do it. */
export function availabilityCopy(state: AssistantAvailability): {
  readonly title: string;
  readonly description: string;
} {
  switch (state) {
    case 'loading':
      return {
        title: 'Loading the assistant',
        description: 'Checking this machine for downloaded models.',
      };
    case 'desktop-only':
      return {
        title: 'Available in the desktop app',
        description:
          'The assistant runs a language model locally on your machine. The browser preview has ' +
          'no local runtime, so it cannot answer here. Download the macOS app to use the assistant.',
      };
    case 'no-model':
      return {
        title: 'No model downloaded yet',
        description: 'The assistant runs a local model on this machine. Download one to get started.',
      };
    case 'no-selection':
      return {
        title: 'Choose a model',
        description: 'A model is downloaded and ready on this machine. Pick one to start chatting.',
      };
    case 'ready':
      return {
        title: 'Assistant ready',
        description: 'A local model is loaded on this machine and ready to answer.',
      };
  }
}
