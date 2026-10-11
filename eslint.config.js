// Flat config. Keep it lean: TS recommended rules, ignore build output.
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'migrations', 'eslint.config.js'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      // Allow intentionally-unused args/vars prefixed with _ (e.g. Express's
      // 4-arg error handler, which must keep `next` to be recognized).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  }
);
