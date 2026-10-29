/**
 * The user's `/juno` files in the app (BACKEND §5.5): listed from the mirror (so opening the page never wakes the computer),
 * written and deleted on the computer and the mirror together. Only paths the user may write are accepted.
 */
import { type Context, type Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { AgentHomeFile } from '@agent-desktop/public-contracts';
import { writeHomeFileInputSchema } from '@agent-desktop/public-contracts';
import type { AgentHomeRow } from '@agent-desktop/contracts';
import { HomeConflictError, HomeUnavailableError, deleteHomeFile, writeHomeFile } from 'juno-agent/modules/home/service';
import { readRowsUnder } from 'juno-agent/modules/home/mirror';
import { homeHash, homePathError, isUserWritablePath } from 'juno-agent/modules/home/paths';
import { isViewFile } from 'juno-agent/modules/memory/views';
import { getOwnerId } from '../auth.js';
import type { AgentdDeps } from './index.js';
import { canMutateAgent, docOwnerId, listAll } from './relationships.js';

const publicFile = (row: AgentHomeRow): AgentHomeFile => ({ path: row.path, content: row.content, hash: row.hash, writer: row.writer, updatedAt: row.updatedAt });
/** A view with no lines left and no row: the file as it reads now. */
const emptyView = (path: string): AgentHomeFile => ({ path, content: '', hash: homeHash(''), writer: 'platform', updatedAt: new Date().toISOString() });

export function registerHome(app: Hono, deps: AgentdDeps) {
  const homeDeps = { store: deps.store, ...(deps.computerd?.home === undefined ? {} : { home: deps.computerd.home }) };

  /** The path in the URL if the caller may write it, else the error response. */
  async function writablePath(c: Context): Promise<string | Response> {
    const path = decodeURIComponent(c.req.path.slice('/v1/home/'.length));
    const ownerId = getOwnerId(c);
    const agents = await listAll(deps.store, 'agents');
    const owned = new Set(agents.items.filter((agent) => canMutateAgent(agent, ownerId) && docOwnerId(agent) === ownerId).map((agent) => agent.id));
    if (homePathError(path) !== null || !isUserWritablePath(path, owned)) {
      return c.json({ error: { code: 'HOME_PATH_NOT_WRITABLE', message: path + ' cannot be changed from the app' } }, 403);
    }
    return path;
  }
  const conflict = (c: Context, path: string) => c.json({ error: { code: 'HOME_CONFLICT', message: path + ' changed since you loaded it; reload and retry' } }, 409);

  app.get('/v1/home', async (c) => {
    const rows = await readRowsUnder(deps.store, getOwnerId(c), c.req.query('path') ?? '');
    return c.json({ files: rows.sort((a, b) => a.path.localeCompare(b.path)).map(publicFile) });
  });

  app.put('/v1/home/*', zValidator('json', writeHomeFileInputSchema), async (c) => {
    const path = await writablePath(c);
    if (typeof path !== 'string') return path;
    const input = c.req.valid('json');
    try {
      if (deps.memory !== undefined && isViewFile(path)) {
        // A view is the rendering of the memory items: the owner's edit becomes item operations, and the file is rendered again.
        const view = await deps.memory.saveView({ ownerId: getOwnerId(c), path, content: input.content, ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash }) });
        return c.json(view === null ? emptyView(path) : publicFile(view));
      }
      const row = await writeHomeFile(homeDeps, { ownerId: getOwnerId(c), path, content: input.content, writer: 'user', ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash }) });
      return c.json(publicFile(row));
    } catch (error) {
      if (error instanceof HomeConflictError) return conflict(c, path);
      throw error;
    }
  });

  app.delete('/v1/home/*', async (c) => {
    const path = await writablePath(c);
    if (typeof path !== 'string') return path;
    try {
      if (deps.memory !== undefined && isViewFile(path)) {
        // Deleting a view clears it: its lines' items are retracted and the view keeps its heading (it is rendered from the items).
        await deps.memory.saveView({ ownerId: getOwnerId(c), path, content: '' });
        return c.json({});
      }
      await deleteHomeFile(homeDeps, { ownerId: getOwnerId(c), path });
      return c.json({});
    } catch (error) {
      if (error instanceof HomeUnavailableError) return c.json({ error: { code: 'COMPUTER_UNAVAILABLE', message: 'Your computer is not reachable; try again' } }, 503);
      throw error;
    }
  });
}
