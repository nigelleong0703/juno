import { defineConfig } from 'vite';

// Dual ESM/CJS library build. The workspace client (HTTP + SSE) and its contracts are bundled in;
// only zod stays external so consumers resolve one copy of it.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es', 'cjs'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['zod'],
    },
  },
});
