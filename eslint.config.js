import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

// Module boundaries (design §2). Flat config replaces a rule's options per
// matching block, so each block below lists the full set it needs.
const NO_UI_LIBS = [
  { group: ['react', 'react/*', 'react-dom', 'react-dom/*'], message: 'Domain and demo code must not depend on React.' },
  { group: ['idb', 'idb/*'], message: 'Only src/persistence may use IndexedDB.' },
];
const NO_APP_LAYERS = [
  { group: ['**/persistence', '**/persistence/**'], message: 'Domain code must not import persistence.' },
  { group: ['**/ui', '**/ui/**'], message: 'Domain code must not import the UI.' },
];
const NO_DEMO = [{ group: ['**/demo', '**/demo/**'], message: 'Domain code must not import demo fixtures.' }];
// Domain code stays pure; the OCR engine lives in src/ocr (brief §27, ocr-design §8).
const NO_OCR_ENGINE = [
  { group: ['tesseract.js', 'tesseract.js/*', '**/ocr', '**/ocr/**'], message: 'Domain code stays pure; the OCR engine lives in src/ocr.' },
];
const NO_ACTIVATION = [
  { group: ['**/knowledge/activation', '**/knowledge/activation/**'], message: 'Extraction adapters cannot activate rules.' },
];

export default defineConfig([
  globalIgnores(['dist', 'coverage', 'test-results', 'playwright-report', 'node_modules']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser },
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['vite.config.ts', 'vitest.config.ts', 'playwright.config.ts', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Guardrails for all application code (REQ-10.1, §2, §8).
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Render untrusted content as text only (REQ-10.1).',
        },
        {
          selector: 'ImportExpression',
          message: 'Dynamic import() is not allowed: the loaded tab must keep working offline (§2).',
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Outcomes must be deterministic (§8). Do not use Math.random.' },
      ],
    },
  },
  {
    files: ['src/domain/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [...NO_UI_LIBS, ...NO_APP_LAYERS, ...NO_DEMO, ...NO_OCR_ENGINE] }] },
  },
  {
    // OCR engine layer (brief §27): domain + tesseract.js only; never storage, UI, demo or activation.
    files: ['src/ocr/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [...NO_UI_LIBS, ...NO_APP_LAYERS, ...NO_DEMO, ...NO_ACTIVATION] }] },
  },
  {
    files: ['scripts/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/demo/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: [...NO_UI_LIBS, ...NO_APP_LAYERS] }] },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}', 'src/main.tsx'],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_UI_LIBS[1]] }] },
  },
  {
    // Extraction adapters may propose data only; they never reach storage or activation (§3).
    files: ['src/domain/capture/*Adapter.ts', 'src/domain/capture/adapter.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...NO_UI_LIBS, ...NO_APP_LAYERS, ...NO_DEMO, ...NO_ACTIVATION] }],
    },
  },
  {
    files: ['src/demo/demoAdapter.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [...NO_UI_LIBS, ...NO_APP_LAYERS, ...NO_ACTIVATION] }] },
  },
]);
