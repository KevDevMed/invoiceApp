/**
 * Desktop platform info the renderer needs at first paint.
 *
 * Installed as `window.desktop` by both the Electron preload
 * (`src/preload/index.ts`) and the browser preview shim
 * (`preview/web-shim.ts`), so renderer code can lay out chrome without
 * caring which host it is running in.
 */

export type DesktopPlatform = 'darwin' | 'win32' | 'linux' | 'web';

export interface DesktopInfo {
  /** `process.platform` under Electron; 'web' in the browser preview. */
  readonly platform: DesktopPlatform;
  /** true when macOS draws traffic lights over the renderer's top-left corner. */
  readonly hasOverlayWindowControls: boolean;
}

/**
 * Pure. Maps a raw platform string to the info the renderer consumes.
 *
 * Unknown values resolve to `'web'` with no overlay controls; this never
 * throws.
 *
 * `hasOverlayWindowControls` is true only for `'darwin'`, mirroring
 * `src/main/window.ts`, which applies `titleBarStyle: 'hiddenInset'` only
 * when `process.platform === 'darwin'`. Every other platform gets the OS's
 * own title bar and needs no reserved corner space.
 */
export function resolveDesktopInfo(rawPlatform: string): DesktopInfo {
  const platform: DesktopPlatform =
    rawPlatform === 'darwin' || rawPlatform === 'win32' || rawPlatform === 'linux'
      ? rawPlatform
      : 'web';

  return {
    platform,
    hasOverlayWindowControls: platform === 'darwin',
  };
}
