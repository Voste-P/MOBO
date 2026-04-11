import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/generated/**', '**/*.cjs'] },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript handles undefined globals/types at build-time.
      'no-undef': 'off',

      // This repo intentionally uses `any` in a few boundary layers (env parsing, Prisma raw queries, JSON).
      // Treat it as a non-blocking concern for now.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
