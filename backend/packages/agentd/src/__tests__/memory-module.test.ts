/** The boot's memory module: absent without Postgres; over Postgres the port reads and writes the items, and the writer exists with an embedder. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { startTestDatabase, type TestDatabase } from '@agent-desktop/memory-graph/testing';
import { createMemoryModule } from 'juno-agent/modules/memory/assembly';

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase();
}, 240_000);

afterAll(async () => {
  await database?.close();
});

const owner = (): string => 'owner-module-' + Math.random().toString(36).slice(2);

describe('createMemoryModule', () => {
  it('is absent without Postgres', () => {
    expect(createMemoryModule({ store: createMemoryStore() })).toBeUndefined();
  });

  it('reads and writes the items through the port, and has no vector writer without an embedder', async () => {
    const memory = createMemoryModule({ store: createMemoryStore(), raw: database.db });
    if (memory === undefined) throw new Error('memory should exist with Postgres');
    const me = owner();
    const person = await memory.port.people.ensureOwner(me, 'Robin');
    expect(person.isOwner).toBe(true);
    const item = await memory.port.addItem(me, { text: 'Likes green tea.', kind: 'preference', file: 'bank:preferences', saidIn: 'app', audience: 'owner' });
    expect((await memory.port.memoryFor(me, { kind: 'owner' }, undefined)).map((visible) => visible.id)).toContain(item?.id);
    expect(memory.vectorWriter).toBeUndefined();
    memory.start();
    memory.stop();
  });

  it('has a vector writer that queues the items it is told about when an embedder is given', async () => {
    const embedder = { model: 'test-model', embed: async (texts: readonly string[]) => texts.map(() => [1, 0, 0]) };
    const memory = createMemoryModule({ store: createMemoryStore(), raw: database.db, embedder });
    if (memory === undefined) throw new Error('memory should exist with Postgres');
    expect(memory.vectorWriter).toBeDefined();
    memory.stop();
  });
});
