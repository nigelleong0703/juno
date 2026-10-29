/** connector_search: the agent's view of the connector catalog, with what the owner has connected and what this deployment cannot offer. Read-only. */
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { docOwner } from '../../../execution/execution-owner.js';
import { configuredClientFor, platformKeyConfigured, withoutCoveredComposio, type CatalogEntry, type ConnectorCatalog } from '../../mcp/index.js';
import { listAll } from '../../memory/util.js';
import type { AppProblem } from '@agent-desktop/public-contracts';
import { agentAppSettings, appProblem } from '../../apps/agent-apps.js';
import { CAPABILITY_TAGS, phraseOfNeed, tagsOfNeed } from '../../apps/provides.js';
import { recommendFor } from '../../apps/recommend.js';
import type { ComputerClientProvider } from '../../../ports/computer/index.js';
import { macUsable } from './macApps.js';

/** The Mac as an offer (not a catalog entry): shown while this agent cannot use it yet. */
const MAC_ENTRY = "- mac | Your Mac | productivity | available | Mail, Calendar and Reminders on the owner's Mac; offer it with connect_request connectors:['mac']";
const MAC_WORDS = 'mac mail email calendar reminders reminder schedule';

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 25;

const inputSchema = z.object({
  query: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().toLowerCase().min(1).max(40).optional(),
  only_unconnected: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  /** A capability tag (`mail.send`) or family (`mail`): the apps of this catalog that provide it, best first, with where each stands for you. */
  need: z.string().trim().toLowerCase().min(1).max(40).optional(),
}).strict();

const STANDING_WORDS = { ready: 'connected', fix: 'needs turning on or signing in again', add: 'available', unavailable: 'not offered on this deployment' } as const;

/**
 * connected (you can use it); turned_off (added, but off for you: a card can ask the owner to turn it on); expired, needs_reconnect or
 * scope_missing (a card can ask the owner to sign in again); available (a Connect card can start it); or why it cannot be connected on this
 * deployment. `not_granted` is a per-tool state and never an app's: the app is connected.
 */
function stateOf(entry: CatalogEntry, problem: AppProblem | undefined, env: Record<string, string | undefined>): string {
  if (problem === undefined || problem === 'not_granted') return 'connected';
  if (problem === 'not_enabled') return 'turned_off';
  if (problem === 'expired' || problem === 'needs_reconnect' || problem === 'scope_missing') return problem;
  if (entry.platformKey === true && !platformKeyConfigured(entry.id, env)) return 'needs_key';
  if (entry.configuredClientIssuer !== undefined && configuredClientFor(entry.configuredClientIssuer, env) === undefined) return 'needs_server';
  return 'available';
}

/** The answer to `need`: what could meet it, best first. Only catalog apps (and the Mac the platform already offers) are ever named. */
async function needResult(opts: { store: Store; catalog: ConnectorCatalog; env?: Record<string, string | undefined> }, ctx: ToolContext, ownerId: string, need: string): Promise<ToolResult> {
  const tags = tagsOfNeed(need);
  if (tags === undefined) return { content: [{ type: 'text', text: 'Error: "' + need + '" is not a capability. Use one of: ' + CAPABILITY_TAGS.join(', ') + ' (or a family such as mail).' }], isError: true };
  const found = await recommendFor({ store: opts.store, catalog: opts.catalog, ownerId, agentId: ctx.agentId, tags, env: opts.env ?? process.env });
  const what = phraseOfNeed(tags);
  const ready = found.filter((candidate) => candidate.standing === 'ready');
  if (ready.length > 0) return { content: [{ type: 'text', text: 'You can already ' + what + ' with: ' + ready.map((candidate) => candidate.name).join(', ') + '. Use its tools; there is nothing to connect.' }] };
  const offered = found.filter((candidate) => candidate.standing !== 'unavailable');
  if (offered.length === 0) return { content: [{ type: 'text', text: 'No app in our catalog can ' + what + (found.length > 0 ? ' on this deployment' : '') + '. Tell the user plainly that it cannot be connected yet; do not suggest apps outside the catalog.' }] };
  const lines = offered.map((candidate) => '- ' + candidate.id + ' | ' + candidate.name + ' | ' + STANDING_WORDS[candidate.standing]);
  return { content: [{ type: 'text', text: ['Apps that can ' + what + ', best first:', ...lines, "Call connect_request with need: '" + need + "' to give the user a card for them, and say in your reply what you need and why. Do not pretend it is done."].join('\n') }] };
}

export function createConnectorSearchTool(opts: { store: Store; catalog: ConnectorCatalog; env?: Record<string, string | undefined>; computer?: ComputerClientProvider }): Tool {
  return {
    name: 'connector_search',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '' },
        category: { type: 'string', description: '' },
        only_unconnected: { type: 'boolean', description: '' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: '' },
        need: { type: 'string', description: '' },
      },
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = inputSchema.safeParse(args ?? {});
      if (!parsed.success) return invalidArguments('connector_search', args, parsed.error);
      const ownerId = ctx.wake.ownerId ?? ctx.ownerId;
      if (ownerId === undefined) return { content: [{ type: 'text', text: 'Error: no owner context.' }], isError: true };
      const { query, category, only_unconnected: onlyUnconnected, limit = DEFAULT_LIMIT, need } = parsed.data;
      if (need !== undefined) return needResult(opts, ctx, ownerId, need);
      const connections = (await listAll(opts.store, 'connections')).filter((connection) => docOwner(connection) === ownerId);
      const settings = await agentAppSettings(opts.store, ctx.agentId);
      const problemOf = (id: string): AppProblem | undefined => appProblem(connections, settings, id);
      const env = opts.env ?? process.env;
      const words = query?.toLowerCase().split(/\s+/) ?? [];
      const matches = withoutCoveredComposio(opts.catalog.list(), env).filter((entry) => {
        if (category !== undefined && entry.category !== category) return false;
        if (onlyUnconnected === true && problemOf(entry.id) === undefined) return false;
        const text = (entry.id + ' ' + entry.name + ' ' + entry.description).toLowerCase();
        return words.every((word) => text.includes(word));
      });
      const macOffer = query !== undefined && category === undefined && words.every((word) => MAC_WORDS.includes(word)) && !(await macUsable(opts.store, opts.computer, ctx.agentId, ctx.signal)) ? [MAC_ENTRY] : [];
      if (matches.length === 0 && macOffer.length > 0) return { content: [{ type: 'text', text: [...macOffer, 'To let the user connect an app that is available, call connect_request with its id.'].join('\n') }] };
      if (matches.length === 0) return { content: [{ type: 'text', text: 'No app in the catalog matches' + (query === undefined ? '' : ' "' + query + '"') + '. Tell the user plainly that no connector exists for it yet.' }] };
      const lines = matches.slice(0, limit).map((entry) => '- ' + entry.id + ' | ' + entry.name + ' | ' + entry.category + ' | ' + stateOf(entry, problemOf(entry.id), env) + ' | ' + entry.description);
      const more = matches.length > limit ? ['(' + String(matches.length - limit) + ' more; narrow the query or raise limit.)'] : [];
      return { content: [{ type: 'text', text: [...lines, ...more, ...macOffer, 'To let the user connect an app that is available, call connect_request with its id.'].join('\n') }] };
    },
  };
}
