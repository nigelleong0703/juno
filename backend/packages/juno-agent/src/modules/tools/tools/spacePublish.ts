/**
 * space_publish: publish an app the agent built in its computer as a Space (BACKEND 5.12).
 *
 * Two steps over a shared flow, because the agent's shell holds no platform credential: the first call for a folder
 * ALLOCATES a port (a `spaces` row, written back to `<dir>/.juno-port` for spaces_tool) and asks the agent to start the
 * app on it; the call after that REGISTERS: computerd (root) checks, from the kernel's socket table, that the agent's own
 * user listens on that port on loopback, wires the in-computer gateway route and the firewall rule, and the tool posts a
 * `render: 'app'` card. The port in the row is the truth; the agent-writable `.juno-port` is only a convenience and is
 * rewritten when it disagrees. Publishing the same folder or `spaceId` again updates title and card.
 */
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { artifactSchema } from '@agent-desktop/public-contracts';
import type { LibraryDocument, SpaceRecord, Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient } from '../computer/client.js';
import { computerFailure } from '../computer/shared.js';
import { newId, nowIso } from '../util.js';
import { requireRequesterContext } from './relationPolicy.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { errorResult, invalidPath, resolveToolPath, throwIfAborted, validateCurrentConversation, type SandboxOpts } from './sandboxFile.js';

const publishSchema = z.object({
  path: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  spaceId: z.string().min(1).optional(),
});

/** The ports apps may use (the same range computerd's registration accepts). */
export const SPACE_PORT_RANGE = { first: 7100, last: 7999 } as const;
const SPACES_ROOT = '/workspace/spaces';
const SLUG = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** The app folder's name when `path` is exactly `/workspace/spaces/<slug>`, else undefined. */
export function spaceSlug(path: string): string | undefined {
  const normalized = posix.normalize(path).replace(/\/+$/, '');
  if (posix.dirname(normalized) !== SPACES_ROOT) return undefined;
  const slug = posix.basename(normalized);
  return SLUG.test(slug) ? slug : undefined;
}

/**
 * The command that starts an app as its agent (the spaces skill's `start`, which runs on the port in `.juno-port`). It is recorded on the
 * row so the platform can start the app again after a cold start of the computer (BACKEND §7.11); computerd only runs this shape.
 */
export const spaceStartCommand = (slug: string): string => '/opt/juno/skills/spaces/spaces_tool.py start ' + slug;

/** The lowest app-range port that is neither reserved by a row nor listening, or undefined when the range is full. */
export function pickPort(reserved: ReadonlySet<number>): number | undefined {
  for (let port = SPACE_PORT_RANGE.first; port <= SPACE_PORT_RANGE.last; port += 1) if (!reserved.has(port)) return port;
  return undefined;
}

/** An unguessable id that is also a valid DNS label (it becomes the app's subdomain). */
export const newSpaceId = (): string => 'sp' + randomBytes(12).toString('hex');

async function allSpaces(scoped: Store): Promise<SpaceRecord[]> {
  const rows: SpaceRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await scoped.list('spaces', { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  return rows;
}

export function createSpacePublishTool(opts: SandboxOpts & { store: Store }): Tool {
  return {
    name: 'space_publish',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '' },
        title: { type: 'string', description: '' },
        spaceId: { type: 'string', description: '' },
      },
      required: ['path', 'title'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = publishSchema.parse(args);
      throwIfAborted(ctx.signal);
      const pathError = invalidPath(parsed.path);
      if (pathError !== undefined) return errorResult(pathError);
      const auth = await requireRequesterContext(ctx);
      if (!auth.ok) return errorResult(auth.error);
      const requester = auth.value;
      const membershipError = await validateCurrentConversation(opts.store, ctx, requester);
      if (membershipError !== undefined) return errorResult(membershipError);
      const scoped = opts.store.forOwner?.(requester.ownerId);
      if (!scoped) return errorResult('Error: owner-scoped storage is unavailable; nothing was saved.');

      try {
        const dir = posix.normalize(await resolveToolPath(opts, ctx, parsed.path)).replace(/\/+$/, '');
        const slug = spaceSlug(dir);
        if (slug === undefined) return errorResult('Error: an app lives in /workspace/spaces/<slug> (lower-case letters, digits, dashes); create it with the spaces skill.');
        const client = requireComputerClient(opts.computer);
        if (client.registerSpace === undefined || client.spacePorts === undefined) return errorResult('Error: Spaces are not available on this deployment.');

        const rows = await allSpaces(scoped);
        const existing = parsed.spaceId === undefined ? rows.find((row) => row.slug === slug) : rows.find((row) => row.id === parsed.spaceId);
        if (existing !== undefined && (existing.agentId !== ctx.agentId || existing.slug !== slug)) {
          return errorResult(parsed.spaceId === undefined ? 'Error: /workspace/spaces/' + slug + ' belongs to another agent; use a different folder name.' : 'Error: that spaceId is not this agent\'s app in this folder.');
        }
        if (parsed.spaceId !== undefined && existing === undefined) return errorResult('Error: no app with this spaceId exists; publish the folder without spaceId first.');

        const portFile = dir + '/.juno-port';
        const writePort = (port: number) => client.writeFile(ctx.agentId, { path: portFile, content: String(port) + '\n' }, ctx.signal);

        if (existing === undefined) {
          const busy = new Set(await client.spacePorts(ctx.agentId, ctx.signal));
          for (const row of rows) busy.add(row.port);
          const port = pickPort(busy);
          if (port === undefined) return errorResult('Error: no free app port is left in this computer (' + String(SPACE_PORT_RANGE.first) + '-' + String(SPACE_PORT_RANGE.last) + ').');
          const at = nowIso();
          const row: SpaceRecord = { id: newSpaceId(), agentId: ctx.agentId, slug, title: parsed.title, port, status: 'allocated', createdAt: at, updatedAt: at };
          await ctx.step('space_allocate', () => scoped.put('spaces', row, { agentId: ctx.agentId, status: 'allocated' }));
          await writePort(port);
          return {
            content: [{ type: 'text', text: 'Allocated port ' + String(port) + ' for ' + parsed.title + ' (spaceId ' + row.id + '), written to ' + portFile + '. Start the app on 127.0.0.1:' + String(port) + ' as a background process (spaces_tool.py start ' + slug + '), then call space_publish again with the same path to publish it.' }],
            details: { spaceId: row.id, port, status: 'allocated' },
          };
        }

        // The row decides the port; a missing or edited .juno-port is repaired.
        const current = await client.readFile(ctx.agentId, portFile, ctx.signal).catch(() => ({ content: '' }));
        if (current.content.trim() !== String(existing.port)) await writePort(existing.port);
        throwIfAborted(ctx.signal);
        const registered = await client.registerSpace(ctx.agentId, { spaceId: existing.id, port: existing.port }, ctx.signal);

        const at = nowIso();
        const artifactId = existing.artifactId ?? newId('lib');
        const result = await ctx.step('space_publish', () =>
          scoped.tx(async (tx) => {
            const card = existing.artifactId === undefined ? null : await (tx.getForUpdate?.('library', artifactId) ?? tx.get('library', artifactId));
            const artifact: LibraryDocument = {
              ...(card ?? {
                id: artifactId, createdByAgentId: ctx.agentId, conversationId: ctx.conversationId, runId: ctx.runId,
                shared: 'private' as const, source: 'agent' as const, tags: [], createdAt: at, pinned: false, mimeType: 'text/html', sizeBytes: 0,
              }),
              name: parsed.title,
              kind: 'canvas',
              updatedAt: at,
              render: 'app',
              spaceId: existing.id,
            };
            await tx.put('library', artifact, { conversationId: artifact.conversationId ?? ctx.conversationId });
            const row: SpaceRecord = { ...existing, title: parsed.title, status: 'published', computerId: registered.computerId, artifactId, start: spaceStartCommand(slug), updatedAt: at };
            await tx.put('spaces', row, { agentId: ctx.agentId, status: 'published', parentId: artifactId });
            // The artifact itself first, also on the first publish: a client draws the card only once it has the artifact.
            await tx.emit({ type: 'artifact.updated', artifact: artifactSchema.parse(artifact) });
            // A new card only when this chat has none for the app; otherwise the existing card updates in place.
            if (card === null || card.conversationId !== ctx.conversationId) {
              const item = { id: newId('itm'), conversationId: ctx.conversationId, type: 'artifact' as const, artifactId, at };
              await tx.put('items', item, { conversationId: ctx.conversationId });
              await emitItemAdded(tx, ctx.conversationId, item);
            }
            return { created: card === null };
          }),
        );
        return {
          content: [{ type: 'text', text: (result.created ? 'Published ' : 'Updated ') + parsed.title + ' as a Space (spaceId ' + existing.id + '). The user can open it from the card in the chat while this computer is running.' }],
          details: { spaceId: existing.id, artifactId, port: existing.port, status: 'published' },
        };
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
