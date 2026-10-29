// PH6: skill selection is configurable over the public contract and owner validated. The skill store is the real versioned one, on an
// embedded Postgres, so the owner boundary is the one production enforces.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Store } from '@agent-desktop/contracts';
import { agentSchema } from '@agent-desktop/public-contracts';
import { createSkillsService, type SkillsService } from '@agent-desktop/memory-graph/skills';
import { seedSkill, startTestDatabase, type TestDatabase } from '@agent-desktop/memory-graph/testing';
import { createTestApp, ownerHeaders } from './test-app.js';
import { MAX_LISTED_SKILLS } from 'juno-agent/execution/brain/resources/skills';
import { errorBodySchema } from 'juno-agent/execution/brain/__tests__/agent-resources.fixtures';

const A = 'owner-alice';
const B = 'owner-bob';

/** Production's service identity: `a` and `b` are owners A and B; any other token is unauthenticated (401). */
function tokenHeaders(token: string): Record<string, string> {
  return token === 'a' ? ownerHeaders(A) : token === 'b' ? ownerHeaders(B) : {};
}

let database: TestDatabase;
let skills: SkillsService;

beforeAll(async () => {
  database = await startTestDatabase();
  skills = createSkillsService(database.db);
  await seedSkill(database.db, A, { id: 'skl-ok', name: 'Harness verification', description: 'Read when asked.', instructions: 'TOKEN-OK' });
  await seedSkill(database.db, B, { id: 'skl-bob', name: 'Bob skill', description: 'Not Alice.', instructions: 'TOKEN-BOB' });
}, 240_000);

afterAll(async () => {
  await database?.close();
});

async function makeApp(): Promise<{ app: ReturnType<typeof createTestApp>; store: Store }> {
  const mem = createMemoryStore();
  const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer(), skills });
  return { app, store: mem };
}

async function call(app: ReturnType<typeof createTestApp>, path: string, method: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method, headers: { ...tokenHeaders('a'), 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return app.request(path, init);
}

describe('PH6 skill selection is configurable and owner validated', () => {
  it('accepts an own skill and rejects unknown and other-owner skills', async () => {
    const { app, store: mem } = await makeApp();
    const created = await call(app, '/v1/agents', 'POST', { name: 'Resource QA' });
    expect(created.status).toBe(201);
    const agent = agentSchema.parse(await created.json());

    const selected = await call(app, '/v1/agents/' + agent.id, 'PATCH', { skillIds: ['skl-ok'] });
    expect(selected.status).toBe(200);
    expect(agentSchema.parse(await selected.json()).skillIds).toEqual(['skl-ok']);

    const unknown = await call(app, '/v1/agents/' + agent.id, 'PATCH', { skillIds: ['skl-none'] });
    expect(unknown.status).toBe(400);
    expect(errorBodySchema.parse(await unknown.json()).error.code).toBe('SKILL_NOT_AVAILABLE');

    expect((await call(app, '/v1/agents/' + agent.id, 'PATCH', { skillIds: ['skl-bob'] })).status).toBe(400);
    expect((await mem.get('agents', agent.id))?.skillIds).toEqual(['skl-ok']);
  });

  it('accepts skillIds on creation and rejects an unknown selection', async () => {
    const { app } = await makeApp();
    const first = await call(app, '/v1/agents', 'POST', { name: 'Anchor' });
    expect(first.status).toBe(201);
    const ok = await call(app, '/v1/agents', 'POST', { name: 'Second', skillIds: ['skl-ok'] });
    expect(ok.status).toBe(201);
    expect(agentSchema.parse(await ok.json()).skillIds).toEqual(['skl-ok']);
    const bad = await call(app, '/v1/agents', 'POST', { name: 'Third', skillIds: ['skl-none'] });
    expect(bad.status).toBe(400);
    expect(errorBodySchema.parse(await bad.json()).error.code).toBe('SKILL_NOT_AVAILABLE');
  });

  it('caps how many skills one selection may carry', async () => {
    const { app } = await makeApp();
    const tooMany = Array.from({ length: MAX_LISTED_SKILLS + 1 }, (_unused, index) => 'skl-' + String(index));
    expect((await call(app, '/v1/agents', 'POST', { name: 'Overflow', skillIds: tooMany })).status).toBe(400);
  });
});
