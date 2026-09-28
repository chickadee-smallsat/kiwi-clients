// Lint config for all JavaScript/TypeScript in the repo: `npm run lint`.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const strict = {
  'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'smart'],
  'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/target/**',
      'plotly-client/web/3d/**',
      'plotly-client/web/vendor/**',
      'plotly-client/web/*.min.js',
      'kiwi-desktop/src-tauri/gen/**',
      'network-analyzer/**',
      '.archive/**',
      '.claude/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  {
    // Browser code served by plotly-client (ES modules unless noted below).
    files: ['plotly-client/web/**/*.js', 'plotly-client/kiwi-3d/src/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, Plotly: 'readonly', GridStack: 'readonly', XLSX: 'readonly' },
    },
    rules: strict,
  },
  {
    files: ['plotly-client/web/landing.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['plotly-client/web/parser.worker.js'],
    languageOptions: { globals: globals.worker },
  },
  {
    // Node tooling: Electron shell, build scripts, test stack and unit tests.
    files: ['**/*.cjs', 'tests/**/*.mjs', 'eslint.config.mjs', 'plotly-client/kiwi-3d/vite.config.js'],
    languageOptions: { globals: globals.node },
    rules: strict,
  },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ['tests/**/*.ts', 'playwright.config.ts'] })),
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];
