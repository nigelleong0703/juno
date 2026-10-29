/**
 * Shared config for the db CLIs (migrate, seed).
 * Both commands require an explicit Postgres connection string: a missing or
 * blank DATABASE_URL fails fast with an actionable error instead of silently
 * skipping work or seeding the wrong store.
 */
import { z } from 'zod';

const DatabaseUrlSchema = z.string().trim().min(1);

export const DATABASE_URL_HINT =
  'DATABASE_URL is missing or blank. Set it to your Postgres connection string, ' +
  'e.g. DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54329/agents';

/** Resolve the database URL from an unknown value, throwing an actionable error when absent. */
export function requireDatabaseUrl(value: unknown = process.env.DATABASE_URL): string {
  const parsed = DatabaseUrlSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(DATABASE_URL_HINT);
  }
  return parsed.data;
}
