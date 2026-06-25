import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'coverage/**', 'node_modules/**', '.worktrees/**'],
  },
  // typescript-eslint STRICT for every TypeScript file (main, preload, renderer,
  // shared, tests, config). Non-type-checked strict keeps lint fast and needs no
  // `parserOptions.project`. `no-undef` is intentionally not enabled — TypeScript
  // resolves identifiers, so environment globals need no `globals` package.
  ...tseslint.configs.strict.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
  })),
  // React + jsx-a11y only for the renderer (the sole React surface).
  {
    files: ['src/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    settings: { react: { version: '18' } },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ...react.configs.flat['jsx-runtime'],
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ...jsxA11y.flatConfigs.recommended,
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // TypeScript supplies prop types; PropTypes are redundant.
      'react/prop-types': 'off',
    },
  },
);
