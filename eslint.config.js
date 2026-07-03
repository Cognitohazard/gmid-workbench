// Flat ESLint config for both packages: the pure-TS core (src/) and the Svelte 5
// web app (web/src, web/e2e). Style/formatting is prettier's job — this lints for
// correctness smells only, so the rule set stays close to the recommended presets.
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'web/dist/',
      'data/',
      '.pdk/',
      '.pdkgen/',
      'release/',
      'web/test-results/',
      'web/playwright-report/',
      'tools/',
    ],
  },
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    // .svelte components AND .svelte.ts rune modules are parsed by svelte-eslint-parser;
    // give it the TS parser for <script lang="ts"> blocks and TS module syntax.
    files: ['web/src/**/*.svelte', 'web/src/**/*.svelte.ts', 'web/src/**/*.svelte.js'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    rules: {
      // `_`-prefixed parameters are the codebase's deliberate unused-arg idiom.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Every {@html} in this app funnels through labels.ts (qLabel/qFormula), whose
      // contract is "always safe for {@html} — unknown input is HTML-escaped". The
      // sanitizer lives in ONE module rather than per-site suppressions; review any
      // new {@html} against that contract.
      'svelte/no-at-html-tags': 'off',
      // Panels render small, order-stable lists (params, rules, legend chips) where
      // index-keyed {#each} is the deliberate idiom; keys would add noise, not safety.
      'svelte/require-each-key': 'off',
    },
  },
);
