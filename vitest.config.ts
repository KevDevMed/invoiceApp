import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Everything under test here is pure logic or SQLite: no DOM needed.
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/shared/**/*.ts', 'src/db/**/*.ts'],
    },
  },
});
