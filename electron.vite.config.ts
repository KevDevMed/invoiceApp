import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

/**
 * Entry points follow electron-vite's conventions and are therefore implicit:
 *   main     -> src/main/index.ts     -> out/main/index.cjs
 *   preload  -> src/preload/index.ts  -> out/preload/index.cjs
 *   renderer -> src/renderer/index.html -> out/renderer/
 *
 * Main and preload are emitted as CommonJS on purpose. `sandbox: true` requires
 * a CommonJS preload, and the main bundle loads better-sqlite3, a native
 * CommonJS addon.
 */
const commonJsOutput = {
  format: 'cjs' as const,
  entryFileNames: '[name].cjs',
  chunkFileNames: '[name]-[hash].cjs',
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
      rollupOptions: { output: commonJsOutput },
    },
  },
  preload: {
    // zod must be bundled rather than externalised: a sandboxed preload cannot
    // require modules from node_modules at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      sourcemap: true,
      rollupOptions: { output: commonJsOutput },
    },
  },
  renderer: {
    plugins: [react()],
    build: {
      sourcemap: true,
      // Relative asset URLs so the bundle works when loaded over file://.
      assetsDir: 'assets',
    },
  },
});
