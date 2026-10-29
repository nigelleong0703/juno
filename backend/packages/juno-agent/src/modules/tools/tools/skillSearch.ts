/**
 * Read-only skill discovery: `skill_search` finds an agent-selected skill by what the caller
 * wants to do, and points at `skill_read` for the body. It never executes a skill and never
 * reads a body during search: only the skill catalog (labels and descriptions, never
 * instructions) reaches the lexical baseline and the single batched System One decision. The
 * catalog is the agent's selected skills plus every active platform skill (the prompt lists only
 * a budgeted subset of those). Always registered, even without a computer: both live in the
 * database. Search results name candidates; only an explicit skill_read loads instructions.
 */
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { rankCandidates } from './candidateRanking.js';
import { listSkillCatalog, skillSource } from './skillCatalog.js';
import { discoveryScopeKey, fingerprintCandidates, readDiscoveryMemo, writeDiscoveryMemo } from './discoveryMemo.js';
import type { PlatformSkillsService, SkillsService } from '@agent-desktop/memory-graph/skills';

export const SKILL_SEARCH = 'skill_search';

/** How many matches one search returns: enough to choose, few enough to stay cheap. */
const MAX_MATCHES = 6;

const searchSchema = z.object({
  query: z.string().trim().min(1).max(200),
}).strict();

export function createSkillSearchTool(opts: { skills?: SkillsService; platformSkills?: Pick<PlatformSkillsService, 'catalog'> } = {}): Tool {
  return {
    name: SKILL_SEARCH,
    description: '',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '' } },
      required: ['query'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = searchSchema.safeParse(args ?? {});
      if (!parsed.success) return invalidArguments(SKILL_SEARCH, args, parsed.error);
      const query = parsed.data.query;
      const catalog = await listSkillCatalog(skillSource(ctx, opts.skills, opts.platformSkills), ctx.agentId);
      if (catalog.entries.length === 0) {
        return {
          content: [{ type: 'text', text: 'No selected or platform skills are available to this agent, so there is nothing to search. Tell the user what is missing.' }],
          details: { ranking: 'lexical', reason: 'empty-catalog', semantic: false, examined: 0, omitted: 0 },
        };
      }
      const skillFp = fingerprintCandidates(catalog.entries.map((entry) => ({ name: entry.label, description: entry.description, hidden: false, identity: entry.readKey })));
      const skillKey = discoveryScopeKey({ ownerId: ctx.ownerId, agentId: ctx.agentId, runId: ctx.runId, scope: 'skills', fingerprint: skillFp, query });
      let outcome = skillKey === undefined ? undefined : readDiscoveryMemo(skillKey);
      if (outcome === undefined) {
        outcome = await rankCandidates({
          query,
          candidates: catalog.entries.map((entry) => ({ name: entry.label, description: entry.description })),
          ctx,
          kind: 'skill',
        });
        if (skillKey !== undefined) writeDiscoveryMemo(skillKey, outcome);
      }
      // Both omission sources count: selected ids beyond the catalog cap plus shortlist overflow.
      const omitted = catalog.omitted + outcome.omitted;
      const lines: string[] = [];
      for (const candidateIndex of outcome.order.slice(0, MAX_MATCHES)) {
        const entry = catalog.entries[candidateIndex];
        if (entry === undefined) continue;
        const head = '- ' + entry.label + ': ' + entry.description;
        // Read keys are never truncated: when the label is shortened, say the exact key to load.
        lines.push(entry.label === entry.readKey ? head : head + ' (load it with skill_read ' + JSON.stringify(entry.readKey) + ')');
      }
      if (omitted > 0) {
        lines.push('- ' + String(omitted) + ' more skills were outside this bounded search; narrow the query if none fits.');
      }
      lines.push('Read one with skill_read: { "name": "<skill>" }. Searching never runs a skill or reads its instructions.');
      const note = outcome.semantic
        ? ''
        : ' (deterministic fallback order: semantic ranking was not applied; other candidates may still fit)';
      return {
        content: [{ type: 'text', text: lines.join('\n') + note }],
        details: { ranking: outcome.semantic ? 'system-one' : 'lexical', reason: outcome.reason, semantic: outcome.semantic, examined: outcome.order.length, omitted },
      };
    },
  };
}
