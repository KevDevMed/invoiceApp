/**
 * Web build of the existing renderer.
 *
 * Same entry (`src/renderer/main.tsx`), same Astryx CSS imports, same routes —
 * only the host page differs, and only to load `web-shim.ts` first. This config
 * is separate from `electron.vite.config.ts` on purpose: the Electron build is
 * frozen, and a browser build wants different defaults anyway (real HTTP URLs
 * rather than `file://`-relative ones).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  // Served from the preview server's root, over http.
  base: '/',
  plugins: [react()],
  server: {
    // The entry module lives above `root`, so Vite's dev server needs to be
    // allowed to read the repository.
    fs: { allow: [path.resolve(here, '..')] },
  },
  build: {
    outDir: path.resolve(here, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: path.resolve(here, 'index.html'),
    },
  },
});
