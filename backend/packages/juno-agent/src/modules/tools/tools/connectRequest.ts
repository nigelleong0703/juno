/** connect_request: put a Connect card for apps (or `mac`, the owner's Mac) in the chat (no routine involved); the server closes it once one of the apps is connected. */
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Request } from '@agent-desktop/public-contracts';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { docOwner } from '../../../execution/execution-owner.js';
import type { ConnectorCatalog } from '../../mcp/index.js';
import { listAll } from '../../memory/util.js';
import { agentAppSettings, appProblem, problemsOf, usableApps } from '../../apps/agent-apps.js';
import type { ComputerClientProvider } from '../../../ports/computer/index.js';
import { macUsable } from './macApps.js';
import { CAPABILITY_TAGS, phraseOfNeed, tagsOfNeed } from '../../apps/provides.js';
import { recommendFor } from '../../apps/recommend.js';
import { newId, nowIso } from '../util.js';

const inputSchema = z.object({
  connectors: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]*$/)).min(1).max(8).optional(),
  /** A capability (`mail.send`): the server picks and ranks the catalog apps for it. */
  need: z.string().trim().toLowerCase().min(1).max(40).optional(),
  label: z.string().trim().min(1).max(160).optional(),
}).strict().refine((value) => (value.connectors === undefined) !== (value.need === undefined), { message: 'give connectors or need, not both and not neither' })
  .refine((value) => value.need !== undefined || value.label !== undefined, { message: 'connectors need a label' });

/** How many ranked apps a card for a need offers: enough to choose, few enough to read at a glance. */
const NEED_CARD_APPS = 3;

/** Edit distance, for naming the nearest real ids when the model made one up. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) next.push(Math.min((next[j - 1] ?? 0) + 1, (row[j] ?? 0) + 1, (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length] ?? 0;
}

/** The three known ids closest to `id`; a known id that contains it (or the reverse) counts as nearest. */
export function closestCatalogIds(catalog: ConnectorCatalog, id: string): string[] {
  const score = (known: string): number => (known.includes(id) || id.includes(known) ? 0 : distance(id, known));
  return catalog.list().map((entry) => entry.id).sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, 3);
}

export function createConnectRequestTool(opts: { store: Store; catalog: ConnectorCatalog; computer?: ComputerClientProvider; env?: Record<string, string | undefined> }): Tool {
  return {
    name: 'connect_request',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        connectors: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8, description: '' },
        need: { type: 'string', description: '' },
        label: { type: 'string', description: '' },
      },
      required: [],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('connect_request', args, parsed.error);
      const ownerId = ctx.wake.ownerId ?? ctx.ownerId;
      if (ownerId === undefined) return { content: [{ type: 'text', text: 'Error: no owner context.' }], isError: true };
      let wanted = parsed.data.connectors ?? [];
      let label = parsed.data.label ?? '';
      if (parsed.data.need !== undefined) {
        // The server picks and ranks from the catalog; the model only says what is needed (provides.ts).
        const tags = tagsOfNeed(parsed.data.need);
        if (tags === undefined) return { content: [{ type: 'text', text: 'Error: "' + parsed.data.need + '" is not a capability. Use one of: ' + CAPABILITY_TAGS.join(', ') + ' (or a family such as mail).' }], isError: true };
        const found = await recommendFor({ store: opts.store, catalog: opts.catalog, ownerId, agentId: ctx.agentId, tags, env: opts.env ?? process.env });
        if (found.some((candidate) => candidate.standing === 'ready')) return { content: [{ type: 'text', text: 'Already available to you; nothing to show. Use the tools of ' + found.filter((candidate) => candidate.standing === 'ready').map((candidate) => candidate.name).join(', ') + '.' }] };
        wanted = found.filter((candidate) => candidate.standing === 'fix' || candidate.standing === 'add').slice(0, NEED_CARD_APPS).map((candidate) => candidate.id);
        if (wanted.length === 0) return { content: [{ type: 'text', text: 'No app in our catalog can ' + phraseOfNeed(tags) + ' on this deployment. Tell the user plainly; do not suggest apps outside the catalog.' }] };
        label = parsed.data.label ?? phraseOfNeed(tags).charAt(0).toUpperCase() + phraseOfNeed(tags).slice(1);
      }
      const unknown = [...new Set(wanted)].filter((id) => id !== 'mac' && opts.catalog.get(id) === undefined);
      if (unknown.length > 0) {
        const hints = unknown.map((id) => id + ' (closest: ' + closestCatalogIds(opts.catalog, id).join(', ') + ')');
        return { content: [{ type: 'text', text: 'Error: not connector catalog ids on this deployment: ' + hints.join('; ') + '. Use connector_search to find the right ids.' }], isError: true };
      }
      const macUsableNow = wanted.includes('mac') && await macUsable(opts.store, opts.computer, ctx.agentId, ctx.signal);
      // What this agent can use: added, signed in and turned on for it. The card says which of the three is missing.
      const connections = (await listAll(opts.store, 'connections')).filter((connection) => docOwner(connection) === ownerId);
      const settings = await agentAppSettings(opts.store, ctx.agentId);
      const usable = usableApps(connections, settings);
      const appIds = [...new Set(wanted)].filter((id) => id !== 'mac' ? !usable.has(id) : !macUsableNow);
      if (appIds.length === 0) return { content: [{ type: 'text', text: 'Already available to you; nothing to show.' }] };
      const problems = problemsOf(appIds, (appId) => appProblem(connections, settings, appId));
      const request: Request & { ownerId: string } = {
        id: newId('req'), kind: 'connect', status: 'pending', title: 'Connect your apps', summary: '', agentId: ctx.agentId, conversationId: ctx.conversationId,
        payload: { kind: 'connect', appIds, ...(problems === undefined ? {} : { problems }), label }, createdAt: nowIso(), ownerId,
      };
      const item = { id: newId('itm'), conversationId: ctx.conversationId, type: 'request' as const, requestId: request.id, at: nowIso() };
      await ctx.step('create_connect_card', async () => {
        await opts.store.put('requests', request, { conversationId: ctx.conversationId });
        await opts.store.emit({ type: 'request.created', request });
        await opts.store.put('items', item, { conversationId: ctx.conversationId });
        await emitItemAdded(opts.store, ctx.conversationId, item);
      });
      return { content: [{ type: 'text', text: 'The Connect card is in the chat.' }] };
    },
  };
}
