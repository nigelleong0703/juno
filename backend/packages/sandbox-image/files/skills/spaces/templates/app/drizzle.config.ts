import { defineConfig } from 'drizzle-kit';

// `bun run db:generate` writes a new SQL file into migrations/ after you change schema.ts; server.ts applies them at start.
export default defineConfig({ dialect: 'sqlite', schema: './schema.ts', out: './migrations' });
