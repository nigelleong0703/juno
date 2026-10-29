/**
 * Bounded first-turn discovery preparation. The registry factories wrap `all(agentId)`
 * here, so the harness can obtain one compact namespace directory plus a small set of
 * task-tail tool/skill candidates after the wake is durable and before the first model call.
 */
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { rankCandidates } from './candidateRanking.js';
import type { RankOutcome } from './candidateRanking.js';
import { discoveryScopeKey, fingerprintCandidates, readDiscoveryMemo, toolIdentityFingerprint, writeDiscoveryMemo } from './discoveryMemo.js';
import { disclosureMode, groupNamespaces, isCompactVisible, renderNamespaceDirectory } from './namespaceDirectory.js';
import type { NamespaceGroup } from './namespaceDirectory.js';
import { listSkillCatalog, skillSource } from './skillCatalog.js';
import type { SkillCatalogEntry } from './skillCatalog.js';
import { toolHashes, type SkillsService } from '@agent-desktop/memory-graph/skills';
import { buildCandidatePool, directoryNote, renderFallbackNote, renderRankedNote } from './prepare-render.js';
import { createHash } from 'node:crypto';
import { createToolNameAliases } from '../../../execution/brain/toolNames.js';
import { selectDiscoveryScope } from './discoveryScope.js';
import type { ToolScope } from '../scope.js';
import { toolTurn } from './mcpTools.js';
import { scopeQuietExit } from './finishQuietly.js';

const MAX_QUERY_CHARS = 2_000;
const GREETINGS = [
  'hi', 'hi there', 'hey', 'hello', 'hello there', 'yo', 'sup', 'thanks', 'thank you', 'good morning',
  'good afternoon', 'good evening', 'how are you', 'what is up', "what's up", 'ok', 'okay',
  '你好', '您好', '谢谢', '好的', '早上好', '晚安',
];

export interface ToolPreparationSource {
  all(agentId: string, signal?: AbortSignal, scope?: ToolScope, turn?: string): Promise<Tool[]>;
  /** The versioned skill store (Postgres); absent, and then skills are not listed and not rechecked. */
  skills?: SkillsService;
}

/**
 * Compare the skills' tool deps with the tools this run has: a changed schema moves that skill to `review` (memory-graph/skills).
 * A failing skill store does not block the turn; the skill then stays as it was until the next check.
 */
async function recheckSkills(skills: SkillsService | undefined, ctx: ToolContext, tools: readonly Tool[]): Promise<void> {
  if (skills === undefined) return;
  try {
    await skills.recheck(ctx.ownerId, toolHashes(tools));
  } catch (error) {
    if (ctx.signal.aborted) throw error;
  }
}

type PrepareDetails = Record<string, string | number | boolean | string[]>;

function isGreeting(query: string): boolean {
  const normalized = query.toLowerCase().replace(/[.!?,，。！？、；;：:]+/g, '').replace(/\s+/g, ' ').trim();
  return normalized.length <= 32 && GREETINGS.indexOf(normalized) !== -1;
}

function emptyResult(mode: string, reason: string): ToolResult {
  return {
    content: [],
    details: {
      mode,
      ranking: 'none',
      reason,
      semantic: false,
      namespaceCount: 0,
      toolCount: 0,
      selectedToolCount: 0,
      skillCount: 0,
      selectedSkillCount: 0,
      omitted: 0,
      rankMs: 0,
      noteChars: 0,
    },
  };
}

// Two text parts: [0] the complete namespace directory (the harness appends it once per session and compaction epoch;
// `directoryKey` is its hash), [1] the per-run suggestions, absent when there are none.
function preparedResult(directory: string, perRun: string, details: PrepareDetails): ToolResult {
  const first = directoryNote(directory);
  const content: ToolResult['content'] = [{ type: 'text', text: first }];
  if (perRun !== '') content.push({ type: 'text', text: perRun });
  const directoryKey = createHash('sha1').update(directory).digest('hex').slice(0, 16);
  return { content, details: { ...details, directoryKey, noteChars: first.length + perRun.length } };
}

function catalogFingerprint(tools: readonly Tool[], skills: readonly SkillCatalogEntry[]): string {
  return fingerprintCandidates([
    ...tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      hidden: !isCompactVisible(tool),
      identity: toolIdentityFingerprint(tool),
    })),
    ...skills.map((skill) => ({ name: skill.label, description: skill.description, hidden: false, identity: skill.readKey })),
  ]);
}

async function readSkills(ctx: ToolContext, skills: SkillsService | undefined): Promise<{ entries: SkillCatalogEntry[]; omitted: number; available: boolean }> {
  try {
    const catalog = await listSkillCatalog(skillSource(ctx, skills), ctx.agentId);
    return { entries: catalog.entries, omitted: catalog.omitted, available: true };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { entries: [], omitted: 0, available: false };
  }
}

function deferredTools(tools: readonly Tool[]): Tool[] {
  return tools.filter((tool) => !isCompactVisible(tool));
}

function rankDetails(outcome: RankOutcome, rankMs: number): PrepareDetails {
  return {
    ranking: outcome.semantic ? 'system-one' : 'lexical',
    reason: outcome.reason,
    semantic: outcome.semantic,
    rankMs,
  };
}

/** `described`: `definitionKey`s of tool definitions already in the model's context (sent since the last compaction); they are listed by name. */
export function createToolPreparer(source: ToolPreparationSource): (query: string, context: ToolContext, described?: ReadonlySet<string>) => Promise<ToolResult> {
  return async (query, ctx, described = new Set()) => {
    ctx.signal.throwIfAborted();
    const mode = disclosureMode();
    if (mode !== 'compact') return emptyResult(mode, mode === 'legacy' ? 'legacy-baseline' : 'disclosure-off');

    const { all } = await scopeQuietExit(ctx, await source.all(ctx.agentId, ctx.signal, ctx.toolScope, toolTurn(ctx)));
    ctx.signal.throwIfAborted();
    await recheckSkills(source.skills, ctx, all);
    const groups: NamespaceGroup[] = groupNamespaces(all);
    // A model with native deferred loading calls a found tool by its wire name and finds tools by its own tool search, so the
    // directory names tools as they are on the wire and no tool definitions are preselected (only skills are).
    const native = ctx.toolSearch === 'responses-tool-search';
    const directory = renderNamespaceDirectory(groups, native ? createToolNameAliases(all.map((tool) => tool.name)).toProtocol : undefined);
    const trimmed = query.trim().slice(0, MAX_QUERY_CHARS);
    if (trimmed === '' || isGreeting(trimmed)) {
      return preparedResult(directory, '', {
        mode,
        ranking: 'none',
        reason: trimmed === '' ? 'empty-query' : 'greeting',
        semantic: false,
        namespaceCount: groups.length,
        toolCount: all.length,
        selectedToolCount: 0,
        skillCount: 0,
        selectedSkillCount: 0,
        omitted: 0,
        rankMs: 0,
      });
    }

    const skills = await readSkills(ctx, source.skills);
    ctx.signal.throwIfAborted();
    const tools = native ? [] : deferredTools(all);
    const scope = selectDiscoveryScope(groups, trimmed);
    const pool = buildCandidatePool(tools, skills.entries, groups, trimmed, scope);
    if (pool.candidates.length === 0) {
      return preparedResult(directory, '', {
        mode, ranking: 'none', reason: 'empty-catalog', semantic: false, namespaceCount: groups.length,
        toolCount: all.length, selectedToolCount: 0, skillCount: skills.entries.length,
        selectedSkillCount: 0, omitted: pool.omitted + skills.omitted, rankMs: 0, catalogAvailable: skills.available,
        scope: scope === undefined ? 'broad' : 'explicit', scopedNamespaces: scope?.groups.length ?? 0,
      });
    }

    const fingerprint = catalogFingerprint(all, skills.entries);
    const memoKey = discoveryScopeKey({
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      scope: 'prepare-tools',
      fingerprint,
      query: trimmed,
    });
    let outcome = memoKey === undefined ? undefined : readDiscoveryMemo(memoKey);
    let rankMs = 0;
    if (outcome === undefined) {
      const started = Date.now();
      try {
        outcome = await rankCandidates({
          query: trimmed,
          candidates: pool.candidates.map((candidate) => ({ name: candidate.name, description: candidate.description, hidden: candidate.kind === 'tool' })),
          ctx,
          kind: 'discovery',
        });
        rankMs = Date.now() - started;
        if (memoKey !== undefined) writeDiscoveryMemo(memoKey, outcome);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        return preparedResult(directory, '', {
          mode, ranking: 'lexical', reason: 'error', semantic: false, namespaceCount: groups.length,
          toolCount: all.length, selectedToolCount: 0, skillCount: skills.entries.length,
          selectedSkillCount: 0, omitted: pool.omitted + skills.omitted, rankMs: Date.now() - started,
          catalogAvailable: skills.available,
          scope: scope === undefined ? 'broad' : 'explicit', scopedNamespaces: scope?.groups.length ?? 0,
        });
      }
    }

    ctx.signal.throwIfAborted();
    const omitted = pool.omitted + skills.omitted + outcome.omitted;
    if (outcome.semantic) {
      const rendered = renderRankedNote(pool.candidates, outcome, described);
      return preparedResult(directory, rendered.text, {
        mode,
        ...rankDetails(outcome, rankMs),
        namespaceCount: groups.length,
        toolCount: all.length,
        selectedToolCount: rendered.selectedTools,
        reusedToolCount: rendered.reusedTools,
        definedTools: rendered.definedTools,
        skillCount: skills.entries.length,
        selectedSkillCount: rendered.selectedSkills,
        omitted,
        omittedDefinitions: rendered.droppedDefinitions,
        omittedSkills: rendered.droppedSkills,
        catalogAvailable: skills.available,
        scope: scope === undefined ? 'broad' : 'explicit',
        scopedNamespaces: scope?.groups.length ?? 0,
      });
    }
    return preparedResult(directory, renderFallbackNote(pool.candidates, outcome, trimmed), {
      mode,
      ...rankDetails(outcome, rankMs),
      namespaceCount: groups.length,
      toolCount: all.length,
      selectedToolCount: 0,
      skillCount: skills.entries.length,
      selectedSkillCount: 0,
      omitted,
      catalogAvailable: skills.available,
      scope: scope === undefined ? 'broad' : 'explicit',
      scopedNamespaces: scope?.groups.length ?? 0,
    });
  };
}
