/** Rows for the skill-evolution tests: runs, steps, items and requests written straight to a throwaway Postgres, as the document store would. */
import type { DurableDb } from '@agent-desktop/durable';

export const HOUR = 60 * 60 * 1000;

export interface RunSeed {
  id: string;
  ownerId: string;
  status?: string;
  conversationId?: string;
  startedAt: Date;
  finishedAt?: Date;
  skills?: Array<{ skillId: string; versionId: string; platform?: boolean }>;
  steps?: unknown[];
  outcome?: string;
  usage?: { costUsd: number; costKnown?: boolean };
}

export async function insertRun(db: DurableDb, seed: RunSeed): Promise<void> {
  const status = seed.status ?? 'completed';
  const doc = {
    id: seed.id, agentId: 'agent-1', ...(seed.conversationId === undefined ? {} : { conversationId: seed.conversationId }), title: 'A run', status, kind: 'chat',
    steps: seed.steps ?? [], usage: { inputTokens: 1, outputTokens: 1, computeSeconds: 0, costUsd: seed.usage?.costUsd ?? 0, ...(seed.usage?.costKnown === undefined ? {} : { costKnown: seed.usage.costKnown }), steps: 0 },
    startedAt: seed.startedAt.toISOString(), lastActivityAt: seed.startedAt.toISOString(),
    ...(seed.finishedAt === undefined ? {} : { finishedAt: seed.finishedAt.toISOString() }),
    ...(seed.skills === undefined ? {} : { skills: seed.skills }), ...(seed.outcome === undefined ? {} : { outcome: seed.outcome }),
  };
  await db.query(
    `INSERT INTO runs (id, owner_id, agent_id, conversation_id, run_id, status, kind, at, doc) VALUES (?, ?, 'agent-1', ?, ?, ?, 'chat', ?::timestamptz, ?::text::jsonb)`,
    [seed.id, seed.ownerId, seed.conversationId ?? null, seed.id, status, seed.startedAt.toISOString(), JSON.stringify(doc)],
  );
}

export interface StepSeed {
  id: string;
  runId: string;
  ownerId: string;
  tool: string;
  status: 'completed' | 'failed';
  errorKind?: string;
  retryOf?: string;
  at: Date;
}

export async function insertStep(db: DurableDb, seed: StepSeed): Promise<void> {
  const doc = { id: seed.id, runId: seed.runId, tool: seed.tool, status: seed.status, ...(seed.errorKind === undefined ? {} : { errorKind: seed.errorKind }), ...(seed.retryOf === undefined ? {} : { retryOf: seed.retryOf }) };
  await db.query(
    `INSERT INTO steps (id, owner_id, agent_id, conversation_id, run_id, status, kind, at, doc) VALUES (?, ?, 'agent-1', NULL, ?, ?, 'shell', ?::timestamptz, ?::text::jsonb)`,
    [seed.id, seed.ownerId, seed.runId, seed.status, seed.at.toISOString(), JSON.stringify(doc)],
  );
}

export async function insertMessage(db: DurableDb, ownerId: string, conversationId: string, id: string, text: string, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO items (id, owner_id, agent_id, conversation_id, run_id, status, kind, at, doc) VALUES (?, ?, 'agent-1', ?, NULL, NULL, 'user_message', ?::timestamptz, ?::text::jsonb)`,
    [id, ownerId, conversationId, at.toISOString(), JSON.stringify({ id, type: 'user_message', conversationId, text })],
  );
}

export async function insertApproval(db: DurableDb, ownerId: string, runId: string, id: string, status: string, reason?: string): Promise<void> {
  const doc = { id, kind: 'approval', status, runId, ...(reason === undefined ? {} : { decision: { reason } }) };
  await db.query(
    `INSERT INTO requests (id, owner_id, agent_id, conversation_id, run_id, status, kind, at, doc) VALUES (?, ?, 'agent-1', NULL, ?, ?, 'approval', NOW(), ?::text::jsonb)`,
    [id, ownerId, runId, status, JSON.stringify(doc)],
  );
}

export async function runDoc(db: DurableDb, id: string): Promise<Record<string, unknown>> {
  const [row] = await db.query<{ doc: unknown }>('SELECT doc FROM runs WHERE id = ?', [id]);
  const doc = row?.doc;
  return (typeof doc === 'string' ? JSON.parse(doc) : doc) as Record<string, unknown>;
}
