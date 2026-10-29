import { defineConfig } from 'vite';

// The `juno` command: one ESM file for Node, with a shebang. It runs after vite.config.ts (the library) and
// must not empty dist, which the library build has just written.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/cli.ts',
      formats: ['es'],
      fileName: () => 'cli.js',
    },
    rollupOptions: {
      external: ['zod', /^node:/],
      output: {
        banner: '#!/usr/bin/env node',
      },
    },
  },
});
