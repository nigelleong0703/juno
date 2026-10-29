// Root lint entry: the real lint runs inside backend/ and frontend/ (`pnpm -C <dir> lint`).
// This config only keeps editors quiet at the root and lints root-level JS without
// touching the two subtrees (their own configs own those files).
export default [
  {
    ignores: [
      '**/node_modules/**',
      'backend/**',
      'frontend/**',
      '**/dist/**',
      '**/out/**',
      '**/build/**',
      '**/release/**',
      '**/coverage/**',
      '**/*.d.ts',
      '.data/**',
    ],
  },
];
