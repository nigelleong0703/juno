// memory_search / memory_explain: the agent's way into what is remembered (BACKEND §5.3, batch 5a). What they reach is decided by who is
// present in the run (`presenceOf`, the same rule the memory section uses): the owner alone sees the owner's memory; a group sees what
// the group has said and what is public; anyone else sees public items only. The owner always comes from the ToolContext, never from
// arguments. Writing is memory_note, forgetting is the user's (the memory page).
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { HOME_DISPLAY } from '../../home/paths.js';
import { presenceOf } from '../../memory/presence.js';
import { referenceOf, type Explanation } from '../../memory/explain.js';
import type { MemoryPort } from '../../memory/port.js';
import { labelsFor, sectionLine } from '../../memory/section.js';

const DEFAULT_HITS = 8;
const MAX_HITS = 20;

const searchSchema = z.object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(MAX_HITS).optional() });
const explainSchema = z.object({ tag: z.string().trim().min(1) });

const result = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) });
const noOwner = (): ToolResult => result('no owner context, so memory is unavailable.', true);
const noMemory = (): ToolResult => result('memory is unavailable: this deployment has no database for memory.', true);

/** The tag a line carries for an item: its claim when it has one, else its own id (as the views write it). */
const tagOf = (item: { id: string; claimId: string | null }): string => (item.claimId === null ? '[mem:' + item.id + ']' : '[claim:' + item.claimId + ']');

export function createMemorySearchTool(opts: { memory?: MemoryPort } = {}): Tool {
  return {
    name: 'memory_search',
    description: '',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '' }, limit: { type: 'integer', minimum: 1, maximum: MAX_HITS, description: '' } },
      required: ['query'],
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = searchSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('memory_search', args, parsed.error);
      if (ctx.ownerId.length === 0) return noOwner();
      const memory = opts.memory;
      if (memory === undefined) return noMemory();
      const presence = await presenceOf(ctx.store, { ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, wake: [ctx.wake] });
      const hits = await memory.search({ ownerId: ctx.ownerId, presence, agentId: ctx.agentId, query: parsed.data.query, limit: parsed.data.limit ?? DEFAULT_HITS });
      if (hits.length === 0) return result('Nothing in memory matches ' + JSON.stringify(parsed.data.query) + '.');
      const labels = await labelsFor(ctx.store, ctx.ownerId, await memory.people.list(ctx.ownerId), hits.map((hit) => hit.item));
      return result(hits.map((hit) => `${sectionLine(hit.item, labels)} ${tagOf(hit.item)}`).join('\n'));
    },
  };
}

function render(explanation: Explanation): string {
  if (explanation.kind === 'not_found') return explanation.reason;
  const evidence = explanation.evidence.map((entry) => {
    const { source } = entry;
    if (source.kind === 'log') return `- An assistant's daily-log note says ${JSON.stringify(entry.quote)} (${HOME_DISPLAY}/${source.path}); that is the assistant's wording, not something the user said`;
    if (source.kind === 'missing') return `- A message said ${JSON.stringify(entry.quote)} (message ${entry.itemId} is no longer available)`;
    const who = source.speaker === 'owner' ? 'The user' : source.speaker === 'agent' ? 'An assistant' : 'Someone other than the user';
    return `- ${who} said ${JSON.stringify(entry.quote)} (message ${entry.itemId} in conversation ${source.conversationId} at ${source.at})`;
  });
  if (explanation.kind === 'claim') {
    const { claim } = explanation;
    return [
      `Claim ${claim.id} (${claim.status}, confidence ${String(claim.confidence)}, recorded ${claim.createdAt}): ${claim.text}`,
      ...explanation.items.map((item) => `- memory ${item.id}: ${item.text} (who may hear it: ${item.audience})`),
      ...evidence,
    ].join('\n');
  }
  const { item } = explanation;
  const lines = [
    `Memory ${item.id} (${item.status}, recorded ${item.createdAt}): ${item.text}`,
    `Said by ${explanation.saidBy} in ${explanation.place}, at ${item.createdAt}. Who may hear it: ${explanation.visibleTo}.`,
    ...(explanation.claim === undefined ? [] : [`It came from claim ${explanation.claim.id} (confidence ${String(explanation.claim.confidence)}).`]),
    ...evidence,
  ];
  return lines.join('\n');
}

export function createMemoryExplainTool(opts: { memory?: MemoryPort } = {}): Tool {
  return {
    name: 'memory_explain',
    description: '',
    parameters: {
      type: 'object',
      properties: { tag: { type: 'string', description: '' } },
      required: ['tag'],
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = explainSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('memory_explain', args, parsed.error);
      if (ctx.ownerId.length === 0) return noOwner();
      const memory = opts.memory;
      if (memory === undefined) return noMemory();
      const reference = referenceOf(parsed.data.tag);
      if (reference === undefined) return result('the tag must be [mem:<id>] or [claim:<id>], as it is shown on a memory line.', true);
      const presence = await presenceOf(ctx.store, { ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, wake: [ctx.wake] });
      const explanation = await memory.explain({ ownerId: ctx.ownerId, presence, agentId: ctx.agentId, reference });
      return result(render(explanation), explanation.kind === 'not_found');
    },
  };
}
