import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `dist/**` is root-anchored, so the browser preview's bundle needs its own
    // entry — otherwise `eslint .` lints minified rollup output.
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'preview/dist/**',
      'release/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/db/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  ...reactHooks.configs['recommended-latest'].map((config) => ({
    ...config,
    files: ['src/renderer/**/*.{ts,tsx}'],
  })),
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // electron-builder hooks: CommonJS, run by electron-builder under node.
    files: ['build/**/*.cjs', 'src/build/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // CommonJS is not a choice here: electron-builder `require()`s the hook
      // from the YAML config at runtime, so it cannot use ESM imports.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/shared/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    files: ['**/*.config.ts', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // The browser preview spans both environments in one directory: server.ts is
    // node, web-shim.ts runs in the page.
    files: ['preview/**/*.{ts,mjs}'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
);
