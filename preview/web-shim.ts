/**
 * Browser implementation of `window.api`.
 *
 * The renderer talks to exactly one thing: the two-function surface that
 * `src/preload/index.ts` puts on `window.api`. That is the seam this preview
 * uses. Nothing in `src/**` changes; this module simply installs a `window.api`
 * that speaks HTTP instead of Electron IPC, and it is loaded before the
 * renderer's entry module so the object is there by the time React mounts.
 *
 * Two properties are load-bearing and mirror the preload exactly:
 *
 *   - the same channel allow-list. An undeclared channel is refused here, before
 *     any request leaves the page, just as the preload refuses it before any
 *     message reaches IPC.
 *   - the same failure shape. `ipcRenderer.invoke` rejects with an `Error` whose
 *     `message` is what main threw; so does this. The renderer's existing
 *     `catch` blocks and error banners therefore work unchanged.
 *
 * `on()` is a real subscription that never fires: the preview has no main
 * process to stream `llm:downloadProgress` or `llm:chatToken` from. It still
 * returns a genuine unsubscribe function, because React effect cleanup calls it
 * and would crash on `undefined`.
 */

import { resolveDesktopInfo } from '../src/shared/desktop';
import {
  isEventChannel,
  isInvokeChannel,
  type IpcChannel,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcRequest,
  type IpcResponse,
} from '../src/shared/ipc-contract';

type Unsubscribe = () => void;

interface PreviewApi {
  invoke<C extends IpcChannel>(channel: C, payload: IpcRequest<C>): Promise<IpcResponse<C>>;
  on<C extends IpcEventChannel>(
    channel: C,
    listener: (payload: IpcEventPayload<C>) => void,
  ): Unsubscribe;
}

/** An `Error` that also carries the server's error code, for callers that want it. */
export class PreviewInvokeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PreviewInvokeError';
  }
}

interface InvokeEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
}

const INVOKE_ENDPOINT = '/api/invoke';

/**
 * Live subscriptions per event channel. Nothing in the preview emits into these
 * — there is no main process — but keeping a real registry means `on()` and its
 * unsubscribe behave like the preload's, instead of being a pair of no-ops that
 * would hide a bug in the renderer's cleanup.
 */
const listeners = new Map<IpcEventChannel, Set<(payload: never) => void>>();

/** Test seam: how many listeners a channel currently has. */
export function listenerCount(channel: IpcEventChannel): number {
  return listeners.get(channel)?.size ?? 0;
}

async function post(channel: string, payload: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(INVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `undefined` payloads (the `z.void()` channels) drop out of the JSON,
      // which is exactly the shape the contract's schema expects to see.
      body: JSON.stringify({ channel, payload }),
    });
  } catch {
    throw new PreviewInvokeError(
      'PREVIEW_UNREACHABLE',
      `${channel} failed: the preview server did not respond.`,
    );
  }

  let body: InvokeEnvelope;
  try {
    body = (await response.json()) as InvokeEnvelope;
  } catch {
    throw new PreviewInvokeError(
      'PREVIEW_BAD_RESPONSE',
      `${channel} failed: the preview server returned a malformed response.`,
    );
  }

  if (body.ok === true) return body.data;

  const code = typeof body.error?.code === 'string' ? body.error.code : 'INTERNAL';
  const message =
    typeof body.error?.message === 'string' ? body.error.message : 'an internal error occurred';
  throw new PreviewInvokeError(code, message);
}

export const previewApi: PreviewApi = {
  invoke(channel, payload) {
    if (!isInvokeChannel(channel)) {
      return Promise.reject(
        new Error(`Blocked IPC invoke on undeclared channel: ${String(channel)}`),
      );
    }
    return post(channel, payload) as Promise<IpcResponse<typeof channel>>;
  },

  on(channel, listener) {
    if (!isEventChannel(channel)) {
      throw new Error(`Blocked IPC subscription to undeclared channel: ${String(channel)}`);
    }
    const wrapped = listener as (payload: never) => void;
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(wrapped);
    // Idempotent, like `removeListener`: React may call cleanup more than once.
    return () => {
      listeners.get(channel)?.delete(wrapped);
    };
  },
};

/** Install `window.api`. Idempotent, so a hot reload does not throw. */
export function installApi(target: Window = window): void {
  Object.defineProperty(target, 'api', {
    value: previewApi,
    configurable: true,
    enumerable: true,
    writable: false,
  });
}

/**
 * Install `window.desktop`. Idempotent, so a hot reload does not throw.
 *
 * Always `'web'`: the preview must never reserve macOS traffic-light space,
 * even when the browser itself runs on a real Mac — which is exactly why the
 * renderer reads this signal instead of sniffing `navigator.userAgent`.
 */
export function installDesktop(target: Window = window): void {
  Object.defineProperty(target, 'desktop', {
    value: resolveDesktopInfo('web'),
    configurable: true,
    enumerable: true,
    writable: false,
  });
}

// Runs on import, before the renderer's entry module — see preview/index.html.
// Guarded so the module can also be imported by the node-environment tests.
if (typeof window !== 'undefined') {
  installApi();
  installDesktop();
}
