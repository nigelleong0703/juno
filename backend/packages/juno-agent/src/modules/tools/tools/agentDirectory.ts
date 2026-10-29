/**
 * agent_directory: permissioned read-only teammate lookup.
 *
 * Returns only id, name, handle and public title — never the home files,
 * configuration, secrets or private history. The one live fact is a teammate's status and what it is doing now, and it
 * is written into the text only for an owner-only run (the owner's own chat or work, BACKEND 5.3); in a shared run it is
 * left out. The team section of the context carries no live status: this is where it is asked for. Pagination walks the
 * authorized stream with an opaque continuation cursor, so teammates past
 * the first store page stay reachable; bounded work per call reports a
 * truncating continuation instead of a dead end. Empty, unavailable,
 * unauthorized and truncated results stay distinct.
 */
import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { agentStatus } from '../../../execution/agent-status.js';
import { isSharedRun } from '../../profile/index.js';
import {
  clampLimit,
  isAgentVisible,
  paginateAuthorized,
  quoteLabel,
  readString,
  requireRequesterContext,
  type RequesterContext,
} from './relationPolicy.js';

const agentDirectorySchema = z.object({
  search: z.string().optional(),
  limit: z.number().optional(),
  cursor: z.string().optional(),
});

export interface DirectoryEntry {
  id: string;
  name: string;
  handle: string;
  title: string;
}

function toEntry(candidate: unknown): DirectoryEntry | undefined {
  const id = readString(candidate, 'id');
  const name = readString(candidate, 'name');
  const handle = readString(candidate, 'handle');
  if (id === undefined || name === undefined || handle === undefined) return undefined;
  return { id, name, handle, title: readString(candidate, 'title') ?? '' };
}

/** The live part of a listed teammate's line: its status, and what it is doing when it is working. Unreadable status says so. */
async function liveLine(store: Store, agentId: string): Promise<string> {
  try {
    const snapshot = await agentStatus(store, agentId);
    return ', status ' + snapshot.status + (snapshot.doing === undefined ? '' : ', doing ' + quoteLabel(snapshot.doing));
  } catch {
    return ', status unknown';
  }
}

function matchesSearch(entry: DirectoryEntry, needle: string): boolean {
  return (
    entry.name.toLowerCase().includes(needle) ||
    entry.handle.toLowerCase().includes(needle) ||
    entry.title.toLowerCase().includes(needle)
  );
}

export function createAgentDirectoryTool(opts: { store: Store }): Tool {
  return {
    name: 'agent_directory',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = agentDirectorySchema.parse(args);
      const auth = await requireRequesterContext(ctx);
      if (!auth.ok) return { content: [{ type: 'text', text: auth.error }], isError: true };
      const requester: RequesterContext = auth.value;
      const needle = parsed.search?.trim().toLowerCase();
      const limit = clampLimit(parsed.limit, 20, 50);
      const ownerOnly = !(await isSharedRun(ctx));
      let unverified = 0;
      const page = await paginateAuthorized(opts.store, 'agents', parsed.cursor, limit, async (candidate) => {
        if (readString(candidate, 'id') === ctx.agentId) return undefined;
        const visibility = isAgentVisible(candidate, { ownerId: requester.ownerId });
        if (!visibility.visible) return undefined;
        const entry = toEntry(candidate);
        if (entry === undefined) return undefined;
        if (needle !== undefined && needle.length > 0 && !matchesSearch(entry, needle)) return undefined;
        if (visibility.unverified) unverified += 1;
        return entry;
      });
      if (!page.ok) return { content: [{ type: 'text', text: page.error }], isError: true };
      const slice = page.value.entries;
      const lines: string[] = [];
      if (slice.length === 0) {
        if (page.value.scanTruncated) {
          lines.push('Directory scan reached its per-call bound with rows remaining; follow nextCursor to continue. No verdict on further agents yet.');
        } else {
          lines.push('No other agents of yours match.');
        }
      } else {
        lines.push('Your agents (' + String(slice.length) + ' shown):');
        for (const entry of slice) {
          const role = entry.title.length > 0 ? ' role ' + quoteLabel(entry.title) : '';
          const live = ownerOnly ? await liveLine(opts.store, entry.id) : '';
          lines.push('- ' + quoteLabel(entry.name) + ' (' + quoteLabel('@' + entry.handle) + ', id ' + entry.id + ')' + role + live);
        }
      }
      if (page.value.nextCursor !== undefined) lines.push('More agents may remain; pass cursor back for the next page.');
      if (page.value.scanTruncated) lines.push('Scan bound hit with rows remaining; the next page continues where this one stopped.');
      if (unverified > 0) lines.push(String(unverified) + ' listed agent(s) are verified by recorded creator only, pending ownership repair.');
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: {
          agents: slice,
          ...(page.value.nextCursor !== undefined ? { nextCursor: page.value.nextCursor } : {}),
          ...(page.value.scanTruncated ? { scanTruncated: true } : {}),
        },
      };
    },
  };
}
