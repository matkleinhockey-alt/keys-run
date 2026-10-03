// @ts-check
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * Enforcement layer 3 of ARCHITECTURE.md's "packages/shared must never import three.js":
 * `no-restricted-imports` bans `three`, `three/*`, and anything under apps/client.
 * (Layers 1/2/5 are package.json / tsconfig / package "exports" + sideEffects:false;
 * layer 4 is the esbuild --metafile assertion in scripts/check-no-three.mjs.)
 */
const noThreeInShared = {
  'no-restricted-imports': [
    'error',
    {
      paths: [
        { name: 'three', message: 'packages/shared must never import three.js — see docs/ARCHITECTURE.md.' },
      ],
      patterns: [
        { group: ['three', 'three/*'], message: 'packages/shared must never import three.js — see docs/ARCHITECTURE.md.' },
        {
          group: ['**/apps/client/**', '../../apps/client/*', '../../../apps/client/*', '../client/*'],
          message: 'packages/shared must never import client code — see docs/ARCHITECTURE.md.',
        },
      ],
    },
  ],
};

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'legacy/**', '**/.no-three-out/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 2022,
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  {
    // packages/shared is pure: see docs/ARCHITECTURE.md "must never import three.js".
    files: ['packages/shared/src/**/*.ts', 'packages/shared/test/**/*.ts'],
    rules: noThreeInShared,
  },
];
