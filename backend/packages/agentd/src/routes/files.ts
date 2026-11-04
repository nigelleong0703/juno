/**
 * Undo for an agent's file writes (BACKEND 5.2d), the owner's side: the kept versions of one path, and putting one back. The rules (what is
 * kept, 20 per path and 14 days, a restore keeps what it replaced) are in juno-agent's modules/files/history.ts, which the agent's own
 * `files.restore` tool uses too. Owner only: the store is the owner's, so another owner's agent or snapshot is simply not found.
 */
import { type Context, type Hono } from 'hono';
import { fileHistoryQuerySchema, fileHistorySchema, restoreFileInputSchema, restoredFileSchema } from '@agent-desktop/public-contracts';
import { FileHistoryError, historyOf, restoreSnapshot } from 'juno-agent/modules/files/history';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';

const RESTORE_TIMEOUT_MS = 60_000;

export function registerFiles(app: Hono, deps: AgentdDeps) {
  const scoped = (c: Context) => {
    const store = deps.store.forOwner?.(getOwnerId(c));
    return deps.blobs === undefined || store === undefined ? undefined : { store, blobs: deps.blobs };
  };
  const unavailable = (c: Context) => c.json({ error: { code: 'FILES_UNAVAILABLE', message: 'file history needs the blob store and an owner-scoped database' } }, 503);

  app.get('/v1/files/history', async (c) => {
    const query = fileHistoryQuerySchema.safeParse({ path: c.req.query('path'), agentId: c.req.query('agentId'), on: c.req.query('on') });
    if (!query.success) return c.json({ error: { code: 'INVALID_QUERY', message: 'path and agentId are required; on is sandbox or mac' } }, 400);
    const made = scoped(c);
    if (made === undefined) return unavailable(c);
    if ((await made.store.get('agents', query.data.agentId)) === null) return c.json({ error: { code: 'NOT_FOUND', message: 'No such agent.' } }, 404);
    return c.json(fileHistorySchema.parse({ items: await historyOf(made, query.data.agentId, { path: query.data.path, on: query.data.on }) }));
  });

  app.post('/v1/files/restore', async (c) => {
    const input = restoreFileInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!input.success) return c.json({ error: { code: 'INVALID_BODY', message: 'snapshotId is required' } }, 400);
    const made = scoped(c);
    if (made === undefined) return unavailable(c);
    if (deps.computer === undefined) return c.json({ error: { code: 'COMPUTER_UNAVAILABLE', message: 'this deployment has no computer to restore the file on' } }, 503);
    try {
      const done = await restoreSnapshot({ ...made, computer: deps.computer }, { snapshotId: input.data.snapshotId, origin: {}, signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS) });
      return c.json(restoredFileSchema.parse(done));
    } catch (error) {
      if (error instanceof FileHistoryError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
      throw error;
    }
  });
}
