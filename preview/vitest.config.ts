/**
 * Vitest project for the preview.
 *
 * Separate from the root `vitest.config.ts`, which is frozen and scoped to
 * `src/**`. Keeping them apart also means the app's own suite keeps its exact
 * pass count, and these tests run under Vite — which resolves the `?raw`
 * migration imports natively, the same way the Electron build does.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(here, '..'),
  test: {
    environment: 'node',
    include: ['preview/__tests__/**/*.test.ts'],
  },
});
