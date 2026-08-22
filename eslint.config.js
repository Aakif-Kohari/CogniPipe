import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

const nodeGlobals = {
  process: 'readonly',
  require: 'readonly',
  module: 'readonly',
  exports: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
};

// packages/* are ESM-only by convention (see CONTRIBUTING.md) — this globals
// set intentionally excludes require/module/exports/__dirname/__filename so
// ESLint still flags accidental CJS syntax. apps/** (the CLI) is allowed the
// full CJS-compatible set since it has different runtime constraints.
const nodeRuntimeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  queueMicrotask: 'readonly',
};

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': 'warn',
    },
  },
  {
    files: ['apps/**/*.ts'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: { globals: nodeRuntimeGlobals },
  },
  {
    files: ['nodes/*/src/**/*.ts', 'nodes/*/__tests__/**/*.ts', 'nodes/*/**/*.test.ts'],
    languageOptions: {
      globals: {
        ...nodeRuntimeGlobals,
        global: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        DOMException: 'readonly',
        Headers: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        RequestInit: 'readonly',
      },
    },
  },
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
  },
  prettierConfig,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/build/**',
      'apps/docs/**',
    ],
  },
];
