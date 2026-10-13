import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Security rules from CLAUDE.md §2: no dangerouslySetInnerHTML, innerHTML, eval, new Function.
const unsafeHtml = [
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'Render text through React text nodes only (CLAUDE.md §2).',
  },
  {
    selector: 'MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
    message: 'Do not touch innerHTML/outerHTML (CLAUDE.md §2).',
  },
  {
    selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
    message: 'Do not insert HTML strings (CLAUDE.md §2).',
  },
  {
    selector: "CallExpression[callee.property.name='write'][callee.object.name='document']",
    message: 'Do not use document.write (CLAUDE.md §2).',
  },
  {
    selector: 'CallExpression[callee.name=/^(confirm|alert|prompt)$/]',
    message: 'Use an in-app confirmation dialog, never confirm/alert/prompt (CLAUDE.md §2).',
  },
];

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'node_modules', 'public', 'playwright-report', 'test-results'] },
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-syntax': ['error', ...unsafeHtml],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.ts'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['scripts/**/*.mjs', '*.config.{js,ts}', 'e2e/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
);
