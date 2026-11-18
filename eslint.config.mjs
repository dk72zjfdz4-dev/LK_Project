import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/data/', '**/uploads/', '**/node_modules/', '**/.recovery/',
      '**/tmp/', '**/temp/', '**/.tmp/', '**/.cache/', '**/*.tmp', '**/*.tmp.*',
      '**/*.sqlite*', '**/*.db', '**/*.db-*',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.nodeBuiltin },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: globals.browser },
  },
];
