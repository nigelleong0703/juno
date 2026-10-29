import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client is built to dist/; server.ts serves dist/ and the API from one port.
export default defineConfig({ plugins: [react()], build: { outDir: 'dist' } });
