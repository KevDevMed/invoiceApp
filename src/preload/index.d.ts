/// <reference types="vite/client" />

/**
 * Ambient declarations shared by every process.
 *
 * The `vite/client` reference above provides the typings for Vite-specific
 * imports used outside the renderer too — `import.meta.glob` in
 * `src/main/ipc/registry.ts` and `*.sql?raw` in `src/db/migrate.ts`.
 */

import type { RendererApi } from './index';

declare global {
  interface Window {
    /**
     * The only main-process surface available to renderer code. Injected by
     * `src/preload/index.ts` through `contextBridge`.
     */
    readonly api: RendererApi;
  }
}

export {};
