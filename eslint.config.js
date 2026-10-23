import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.boost/**',
      '**/.next/**',
      '**/next-env.d.ts',
      '**/test-results/**',
      '**/playwright-report/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  { files: ['**/*.js', '**/*.mjs'], extends: [tseslint.configs.disableTypeChecked] },
  { files: ['apps/dashboard/**/*.tsx', 'apps/dashboard/**/*.ts'], ...reactHooks.configs.flat.recommended },
  {
    // Pages, actions and routes get data only through backendForViewer()/backendIfLoggedIn(),
    // which check the login first.
    files: ['apps/dashboard/src/app/**', 'apps/dashboard/src/components/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/lib/server/env'],
              importNames: ['backendWithoutLoginCheck'],
              message: 'Use backendForViewer() or backendIfLoggedIn() from lib/server/session.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
