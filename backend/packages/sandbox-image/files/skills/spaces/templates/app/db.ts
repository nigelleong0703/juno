import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

// The database is one file inside the app folder (data/app.db), so it moves and backs up with the app.
mkdirSync('data', { recursive: true });
export const db = drizzle(new Database('data/app.db', { create: true }));
migrate(db, { migrationsFolder: 'migrations' });
