/**
 * Database migration runner: applies versioned migrations from packages/db/migrations/
 * Runs against PostgreSQL via the connection string from DATABASE_URL env.
 */

import postgres from 'postgres';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createLogger } from '@agent-desktop/log';
import { requireDatabaseUrl } from './db-config.js';

const log = createLogger({ service: 'db' });

let DATABASE_URL: string;
try {
  DATABASE_URL = requireDatabaseUrl();
} catch (error) {
  log.error({ err: error }, 'DATABASE_URL is missing or blank; set it to your Postgres connection string');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function ensureMigrationsTable(sql: ReturnType<typeof postgres>) {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT NOW()
    )
  `;
}

async function getAppliedMigrations(sql: ReturnType<typeof postgres>): Promise<Set<string>> {
  const rows = await sql<Array<{ version: string }>>`SELECT version FROM schema_migrations`;
  return new Set(rows.map((row) => row.version));
}

async function getMigrationFiles(): Promise<string[]> {
  const migrationsDir = join(__dirname, '..', 'migrations');
  const files = await readdir(migrationsDir);
  return files
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function migrate() {
  const sql = postgres(DATABASE_URL);

  try {
    log.info('Starting migrations...');

    await ensureMigrationsTable(sql);

    const appliedMigrations = await getAppliedMigrations(sql);
    const migrationFiles = await getMigrationFiles();

    const pendingMigrations = migrationFiles.filter(
      (file) => !appliedMigrations.has(file)
    );

    if (pendingMigrations.length === 0) {
      log.info('✓ All migrations already applied');
      process.exit(0);
    }

    log.info(`Applying ${pendingMigrations.length} migration(s)...`);

    for (const migrationFile of pendingMigrations) {
      const version = migrationFile;
      const migrationsDir = join(__dirname, '..', 'migrations');
      const migrationPath = join(migrationsDir, migrationFile);

      log.info(`Applying ${version}...`);

      const migrationSql = await readFile(migrationPath, 'utf-8');

      await sql.begin(async (tx) => {
        await tx.unsafe(migrationSql);
        await tx`
          INSERT INTO schema_migrations (version)
          VALUES (${version})
        `;
      });

      log.info(`✓ Applied ${version}`);
    }

    log.info('✓ All migrations applied successfully');
    process.exit(0);
  } catch (error) {
    log.error({ err: error }, '✗ Migration failed');
    process.exit(1);
  } finally {
    await sql.end();
  }
}

migrate();
