/**
 * Postgres 0041 on a scratch database: `models.fastModel` becomes `models.tiers.fast` and the owner-wide
 * `models.reasoningEffort` is dropped; everything else in the row (and rows with neither key) stays, and a second run changes nothing.
 * Boots its own throwaway embedded Postgres; touches no running database.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PG_MIGRATIONS = resolve(HERE, '../../migrations');
const PG_FILE = '0041_effort_tiers.sql';

const FAST = { providerId: 'mprov-1', modelId: 'glm-5.3-flash' };

/** [row id, owner, doc]. */
const ROWS: Array<[string, string, Record<string, unknown>]> = [
  ['both', 'owner-a', { id: 'both', general: { language: 'en' }, models: { defaultModel: 'kimi-k3', providerId: 'mprov-1', reasoningEffort: 'high', temperature: 0.2, fastModel: FAST } }],
  ['effort-only', 'owner-b', { id: 'effort-only', models: { defaultModel: 'kimi-k3', reasoningEffort: 'max' } }],
  ['null-fast', 'owner-c', { id: 'null-fast', models: { defaultModel: null, fastModel: null } }],
  ['already', 'owner-d', { id: 'already', models: { defaultModel: 'x', tiers: { chat: { effort: 'low' } } } }],
  ['no-models', 'owner-e', { id: 'no-models', general: { language: 'en' } }],
];

const EXPECTED: Record<string, Record<string, unknown>> = {
  both: { id: 'both', general: { language: 'en' }, models: { defaultModel: 'kimi-k3', providerId: 'mprov-1', temperature: 0.2, tiers: { fast: FAST } } },
  'effort-only': { id: 'effort-only', models: { defaultModel: 'kimi-k3' } },
  'null-fast': { id: 'null-fast', models: { defaultModel: null } },
  already: { id: 'already', models: { defaultModel: 'x', tiers: { chat: { effort: 'low' } } } },
  'no-models': { id: 'no-models', general: { language: 'en' } },
};

describe('Postgres 0041', () => {
  let dir: string;
  let pg: EmbeddedPostgres;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tiers-migration-pg-'));
    const port = await new Promise<number>((done) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const free = (server.address() as { port: number }).port;
        server.close(() => done(free));
      });
    });
    pg = new EmbeddedPostgres({ databaseDir: join(dir, 'pg'), port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => undefined, onError: () => undefined });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('scratch');
    sql = postgres(`postgres://postgres:postgres@127.0.0.1:${String(port)}/scratch`, { onnotice: () => undefined });
    for (const file of readdirSync(PG_MIGRATIONS).filter((f) => f.endsWith('.sql') && f < PG_FILE).sort()) await sql.unsafe(readFileSync(join(PG_MIGRATIONS, file), 'utf8'));
    for (const [id, owner, doc] of ROWS) await sql`INSERT INTO settings (id, owner_id, doc) VALUES (${id}, ${owner}, ${sql.json(doc as never)})`;
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
  }, 240_000);

  afterAll(async () => {
    await sql?.end();
    await pg?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('maps fastModel to tiers.fast and drops reasoningEffort; a second run changes nothing', async () => {
    const read = async () => Object.fromEntries((await sql<Array<{ id: string; doc: unknown }>>`SELECT id, doc FROM settings`).map((row) => [row.id, row.doc]));
    expect(await read()).toEqual(EXPECTED);
    await sql.unsafe(readFileSync(join(PG_MIGRATIONS, PG_FILE), 'utf8'));
    expect(await read()).toEqual(EXPECTED);
  });
});
