/**
 * Namespace disclosure acceptance: compact core, account-aware namespace
 * directory, scoped search, memo reuse, and the no-Jev one-model flow.
 * Runs the production registry wiring plus the tools directly with scripted
 * System One answers. Complements the lead-owned pin (intended baseline
 * failures) and the harness disclosure tests (legacy/compact/off modes).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemOneAnswer, SystemOneQuestion } from '../../../ports/system-one/index.js';
import type { Store, Tool, ToolContext } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { requestScopedStore, runWithOwner } from '../../../owner-context.js';
import type { Agent } from '@agent-desktop/public-contracts';
import { createFakeSkills, type FakeSkill } from '../../../testing/skills.js';
import { createToolRegistry } from '../index.js';
import { createToolSearchTool, parseToolCall, presentForModel } from '../tools/toolSearch.js';
import { disclosureMode, groupNamespaces, matchNamespace, renderNamespaceDirectory } from '../tools/namespaceDirectory.js';
import { clearDiscoveryMemo, discoveryScopeKey, fingerprintCandidates, readDiscoveryMemo, writeDiscoveryMemo } from '../tools/discoveryMemo.js';
import { lexicalHits, lexicalOrder, rankCandidates } from '../tools/candidateRanking.js';
const OWNER = 'owner-ns';
const AGENT = 'agent-ns';
const AT = '2026-01-01T00:00:00Z';
function stub(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    replay: 'safe',
    sideEffect: false,
    execute: async () => ({ content: [] }),
  };
}
function mcpTool(name: string, connectionId: string, connectionName: string, account?: string): Tool {
  return {
    ...stub(name),
    description: 'Connected operation ' + name,
    mcp: true,
    origin: { connectionId, connectionName, toolName: name, access: 'read', ...(account === undefined ? {} : { account }) },
  };
}
function context(systemOne?: ToolContext['systemOne'], runId = 'run-ns-1', store?: Store): ToolContext {
  return {
    ownerId: OWNER,
    agentId: AGENT,
    conversationId: 'conversation',
    runId,
    store: store === undefined ? createMemoryStore() : store,
    blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(),
    wake: wakeEventSchema.parse({ id: 'w', ownerId: OWNER, agentId: AGENT, conversationId: 'conversation', sessionKey: AGENT + ':conversation', kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: new Date().toISOString() }),
    step: async (_name, fn) => fn(),
    signal: new AbortController().signal,
    ...(systemOne === undefined ? {} : { systemOne }),
  };
}
beforeEach(() => {
  clearDiscoveryMemo();
});

describe('compact model view', () => {
  it('keeps a small fixed core on the production registry while the full catalog stays available', async () => {
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer() });
    const all = await registry.forAgent('agent-ns');
    const shown = presentForModel(all, {});
    expect(all.length).toBeGreaterThan(30);
    expect(shown.length).toBeLessThanOrEqual(10);
    expect(shown.map((entry) => entry.name)).toEqual(expect.arrayContaining(['send_message', 'tool_search', 'tool_call', 'skill_search', 'skill_read', 'child_spawn', 'todo_write']));
    // Needed only while a request is pending, so it sits behind disclosure but stays registered and policy-checked.
    expect(shown.map((entry) => entry.name)).not.toContain('request_withdraw');
    expect(registry.get('request_withdraw')).toBeDefined();
    expect(registry.get('memory_search')).toBeDefined();
    const names = shown.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks non-core production builtins deferred while unmarked custom stubs stay visible', () => {
    expect(disclosureMode({})).toBe('compact');
    expect(disclosureMode({ TOOL_DISCLOSURE: 'legacy' })).toBe('legacy');
    expect(disclosureMode({ TOOL_DISCLOSURE: 'off' })).toBe('off');
    const deferred = stub('memory_search');
    deferred.deferLoading = true;
    const mcp = mcpTool('gmail_search', 'conn-1', 'Gmail');
    const shown = presentForModel([stub('send_message'), stub('tool_search'), deferred, stub('custom_stub'), mcp], {});
    expect(shown.map((entry) => entry.name)).toContain('custom_stub');
    expect(shown.map((entry) => entry.name)).not.toContain('memory_search');
    expect(shown.filter((entry) => entry.mcp === true)).toHaveLength(0);
    expect(presentForModel([stub('send_message'), stub('tool_search'), stub('tool_call'), stub('custom')], { TOOL_DISCLOSURE: 'off' }).map((entry) => entry.name)).not.toContain('tool_search');
  });

  it('treats MCP as deferred by default and hides it below the old 24 cap', () => {
    const mcp = [mcpTool('notion_search', 'c1', 'Notion'), mcpTool('gmail_read', 'c2', 'Gmail')];
    expect(presentForModel(mcp.map((entry) => entry), {})).toHaveLength(0);
    const legacy = presentForModel(mcp.map((entry) => entry), { TOOL_DISCLOSURE: 'legacy' });
    expect(legacy.map((entry) => entry.name)).toContain('notion_search');
  });
});

describe('namespace directory', () => {
  const workSearch = mcpTool('gmail_search', 'conn-work', 'Gmail', 'Work');
  const workRead = mcpTool('gmail_read', 'conn-work', 'Gmail', 'Work');
  const personalSend = mcpTool('gmail_send', 'conn-personal', 'Gmail', 'Personal');
  const notionSearch = mcpTool('notion_search', 'conn-notion', 'Notion');
  const notionGet = mcpTool('notion_get_page', 'conn-notion', 'Notion');
  const notionCreate = mcpTool('notion_create_page', 'conn-notion', 'Notion');
  const notionUpdate = mcpTool('notion_update_page', 'conn-notion', 'Notion');
  const notionDelete = mcpTool('notion_delete_page', 'conn-notion', 'Notion');
  const memorySearch = stub('memory_search');
  memorySearch.deferLoading = true;
  const transcriptSearch = stub('transcript_search');
  transcriptSearch.deferLoading = true;
  const tools = [stub('send_message'), workSearch, workRead, personalSend, notionSearch, notionGet, notionCreate, notionUpdate, notionDelete, memorySearch, transcriptSearch];

  it('gives same-connector accounts distinct display namespaces while canonical names never change', () => {
    const groups = groupNamespaces(tools);
    const namespaces = groups.map((group) => group.namespace);
    expect(namespaces).toContain('mcp__gmail__work__*');
    expect(namespaces).toContain('mcp__gmail__personal__*');
    expect(namespaces).toContain('mcp__notion__*');
    expect(namespaces).not.toContain('mcp__gmail__*');
    const work = groups.find((group) => group.namespace === 'mcp__gmail__work__*');
    expect(work === undefined ? [] : work.tools.map((tool) => tool.name).sort()).toEqual(['gmail_read', 'gmail_search']);
  });

  it('lists every group, with all names for small groups and a count plus search hint for big ones', () => {
    const many = Array.from({ length: 40 }, (_, index) => {
      const tool = stub('zz' + String(index) + '_group');
      tool.deferLoading = true;
      return tool;
    });
    const big = Array.from({ length: 9 }, (_, index) => mcpTool('crm_op' + String(index), 'conn-crm', 'Crm'));
    const dir = renderNamespaceDirectory(groupNamespaces([...tools, ...many, ...big]));
    for (let index = 0; index < 40; index += 1) expect(dir).toContain('zz' + String(index) + '_group');
    const crm = dir.split('\n').find((line) => line.includes('mcp__crm__*'));
    expect(crm).toContain('(9 tools): list with tool_search namespace filter');
    expect(crm).not.toContain('crm_op0');
  });

  it('groups deferred builtins by family and lists all names of a small group', () => {
    const groups = groupNamespaces(tools);
    const namespaces = groups.map((group) => group.namespace);
    expect(namespaces).toContain('memory');
    expect(namespaces).toContain('transcript');
    expect(namespaces).not.toContain('builtin');
    const directory = renderNamespaceDirectory(groups);
    const notionLine = directory.split('\n').find((line) => line.includes('mcp__notion__*'));
    expect(notionLine === undefined ? '' : notionLine).toContain('5 tools');
    expect(notionLine === undefined ? '' : notionLine).toContain('notion_delete_page');
    expect(directory).toContain('Work');
  });

  it('orders deterministically regardless of input enumeration order', () => {
    const groups = groupNamespaces(tools);
    const reversed = groupNamespaces([...tools].reverse());
    expect(renderNamespaceDirectory(reversed)).toBe(renderNamespaceDirectory(groups));
  });
});

describe('namespace matching', () => {
  const groups = groupNamespaces([mcpTool('gmail_search', 'w1', 'Gmail', 'Work'), mcpTool('gmail_send', 'p1', 'Gmail', 'Personal'), mcpTool('notion_search', 'n1', 'Notion')]);

  it('resolves an exact account scope to one group and a base scope to every labeled group', () => {
    expect(matchNamespace(groups, 'mcp__gmail__work__*').map((group) => group.namespace)).toEqual(['mcp__gmail__work__*']);
    expect(matchNamespace(groups, 'gmail').map((group) => group.namespace).sort()).toEqual(['mcp__gmail__personal__*', 'mcp__gmail__work__*']);
    expect(matchNamespace(groups, 'mcp__notion__*').map((group) => group.namespace)).toEqual(['mcp__notion__*']);
  });

  it('matches bare slugs and starless display forms, and never guesses', () => {
    expect(matchNamespace(groups, 'mcp__gmail__work').map((group) => group.namespace)).toEqual(['mcp__gmail__work__*']);
    expect(matchNamespace(groups, 'notion').map((group) => group.namespace)).toEqual(['mcp__notion__*']);
    expect(matchNamespace(groups, 'Notion').map((group) => group.namespace)).toEqual(['mcp__notion__*']);
    expect(matchNamespace(groups, 'bogus-connector')).toEqual([]);
    expect(matchNamespace(groups, '')).toEqual([]);
  });
});

describe('discovery memo', () => {
  const a = [{ name: 'a', description: 'x' }, { name: 'b', description: 'y' }];
  const b = [{ name: 'b', description: 'y' }, { name: 'a', description: 'x' }];

  it('invalidates on enumeration order and requires a complete owner/agent/run scope', () => {
    expect(fingerprintCandidates(a)).not.toBe(fingerprintCandidates(b));
    expect(discoveryScopeKey({ ownerId: '', agentId: AGENT, runId: 'r', scope: 'tools', fingerprint: 'f', query: 'q' })).toBeUndefined();
    expect(discoveryScopeKey({ ownerId: OWNER, agentId: AGENT, runId: 'r', scope: 'tools', fingerprint: 'f', query: 'q' })).toBe(discoveryScopeKey({ ownerId: OWNER, agentId: AGENT, runId: 'r', scope: 'tools', fingerprint: 'f', query: 'q' }));
  });

  it('preserves the relevant count through a write/read round trip', () => {
    writeDiscoveryMemo('memo-key-1', { order: [1, 0], semantic: true, reason: 'semantic', omitted: 0, relevantCount: 1 });
    expect(readDiscoveryMemo('memo-key-1')?.relevantCount).toBe(1);
  });
});

function scoreAnswer(score: number, confidence = 0.99): SystemOneAnswer {
  return { type: 'score', score, probabilities: [0, 0, 0.05, 0.95], confidence };
}

function scoringAsk(target: string) {
  return vi.fn(async (_state: string, questions: Record<string, SystemOneQuestion>) => {
    const out: Record<string, SystemOneAnswer> = {};
    for (const key of Object.keys(questions)) {
      const asked = questions[key];
      const text = asked === undefined ? '' : asked.instructions;
      out[key] = text.includes(target) ? scoreAnswer(3) : scoreAnswer(0, 0.9);
    }
    return out;
  });
}

describe('ranking relevance', () => {
  const candidates = [
    { name: 'notion_lookup', description: 'Look up pages in Notion' },
    { name: 'archive_mail', description: 'Move mail into archive' },
    { name: 'read_task', description: 'Read a task' },
  ];

  it('reports the promoted prefix length on semantic rank and zero on lexical fallback', async () => {
    const outcome = await rankCandidates({ query: 'lookup notion pages', ctx: context({ ask: scoringAsk('notion_lookup') }, 'run-rel-1'), candidates, kind: 'tool' });
    expect(outcome.semantic).toBe(true);
    expect(outcome.relevantCount).toBe(1);
    expect(outcome.order[0]).toBe(0);
    const lexical = await rankCandidates({ query: 'lookup notion pages', ctx: context(undefined, 'run-rel-2'), candidates, kind: 'tool' });
    expect(lexical.semantic).toBe(false);
    expect(lexical.relevantCount).toBe(0);
  });

  it('prefers exact name hits over description filler without any model call', () => {
    expect(lexicalHits('search notes', 'notes_search_notes', 'Find saved notes')).toBe(6);
    expect(lexicalHits('search notes', 'notes_list_label_0', 'does not search note text')).toBe(4);
    expect(lexicalOrder('search notes', [
      { name: 'notes_search_notes', description: 'Find saved notes' },
      { name: 'notes_list_label_0', description: 'does not search note text' },
    ])).toEqual([0, 1]);
  });
});

function bigSchemaTool(): Tool {
  return {
    ...stub('tall_schema_tool'),
    description: 'Tall schema tool under test',
    parameters: { type: 'object', properties: { bigprop: { type: 'string', description: 'x'.repeat(9000) } } },
    mcp: true,
    origin: { connectionId: 'c-tall', connectionName: 'Tall', toolName: 'tall', access: 'read' },
  };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('');
}

describe('scoped search without Jev', () => {
  it('lists a namespace scope with complete schemas and no model call', async () => {
    const search = createToolSearchTool({ all: async () => [stub('send_message'), bigSchemaTool()], visible: async () => new Set(['send_message']) });
    const result = await search.execute({ query: '', namespace: 'tall' }, context(undefined, 'run-ns-list'));
    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain('tall_schema_tool');
    expect(text).toContain('bigprop');
    expect(text.length).toBeGreaterThan(9000);
  });

  it('returns the whole best-match schema on an exact query instead of a 1500-char cut', async () => {
    const search = createToolSearchTool({ all: async () => [stub('send_message'), bigSchemaTool()], visible: async () => new Set(['send_message']) });
    const result = await search.execute({ query: 'tall schema tool' }, context(undefined, 'run-ns-exact'));
    const text = textOf(result);
    expect(text).toContain('tall_schema_tool');
    expect(text).toContain('bigprop');
    expect(text.length).toBeGreaterThan(9000);
  });

  it('names nothing on an unknown namespace instead of guessing', async () => {
    const search = createToolSearchTool({ all: async () => [stub('send_message'), mcpTool('notion_search', 'n1', 'Notion')], visible: async () => new Set() });
    const result = await search.execute({ query: '', namespace: 'bogus' }, context(undefined, 'run-ns-unknown'));
    expect(textOf(result)).toContain('No namespace matches');
  });

  it('narrows a namespace with a query and keeps the full routine', async () => {
    const tools = [stub('send_message'), mcpTool('notion_search', 'n1', 'Notion'), mcpTool('notion_read', 'n1', 'Notion'), mcpTool('gmail_search', 'g1', 'Gmail')];
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set(['send_message']) });
    const result = await search.execute({ query: 'notion_search', namespace: 'notion' }, context(undefined, 'run-ns-narrow'));
    const text = textOf(result);
    expect(text).toContain('notion_search');
    expect(text).not.toContain('gmail_search');
    expect(text).toContain('schema: ');
  });

  it('reuses one ranking for an identical repeated search', async () => {
    const tools = [stub('send_message'), mcpTool('notion_lookup', 'n1', 'Notion'), mcpTool('archive_mail', 'a1', 'Mail')];
    const ask = scoringAsk('notion_lookup');
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set(['send_message']) });
    const first = await search.execute({ query: 'lookup notion pages' }, context({ ask }, 'run-memo-1'));
    const second = await search.execute({ query: 'lookup notion pages' }, context({ ask }, 'run-memo-1'));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(textOf(first)).toBe(textOf(second));
    expect(textOf(first)).toContain('notion_lookup');
  });
});

describe('one-model flow without Jev', () => {
  it('goes directory to namespace search to canonical call with policy visibility intact', async () => {
    const tools = [stub('send_message'), mcpTool('notion_search', 'n1', 'Notion'), mcpTool('gmail_search', 'g1', 'Gmail')];
    expect(presentForModel(tools, {}).map((entry) => entry.name)).not.toContain('notion_search');
    expect(tools.map((entry) => entry.name)).toContain('notion_search');
    expect(renderNamespaceDirectory(groupNamespaces(tools))).toContain('mcp__notion__*');
    const search = createToolSearchTool({ all: async () => tools, visible: async () => new Set(['send_message']) });
    const result = await search.execute({ query: '', namespace: 'notion' }, context(undefined, 'run-flow-1'));
    expect(textOf(result)).toContain('notion_search');
    expect(textOf(result)).not.toContain('gmail_search');
    expect(parseToolCall({ name: 'notion_search', arguments: {} })).toEqual({ name: 'notion_search', arguments: {} });
  });
});

function agentRow(skillIds: string[]): Agent {
  return {
    id: AGENT, name: 'Agent', handle: AGENT,
    avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 'T', status: 'idle', section: 'Inbox', pinned: false, lastActivity: '', unreadCount: 0,
    model: { planner: { provider: 'p', model: 'm' }, computer: { provider: 'p', model: 'm' }, fast: { provider: 'p', model: 'm' } },
    channels: [], macAccess: false, skillIds, pluginIds: [], sharing: { publishedToTeam: false },
    createdBy: OWNER, createdAt: AT, updatedAt: AT,
  };
}

function skillRow(id: string, name: string, description: string, instructions: string): FakeSkill {
  return { id, name, description, instructions, ownerId: OWNER };
}

/** The owner's skills for the memo test; the agent selects the first two. */
const MEMO_SKILLS = createFakeSkills([
  skillRow('skill-pdf', 'pdf_lookup', 'Look up text inside PDF documents', 'BODY: read PDFs page by page.'),
  skillRow('skill-mail', 'mail_triage', 'Sort the mailbox by priority', 'BODY: triage mail oldest first.'),
]);

async function skillStore(): Promise<Store> {
  const store = requestScopedStore(createMemoryStore());
  await runWithOwner(OWNER, async () => {
    await store.put('agents', agentRow(['skill-pdf', 'skill-mail']));
  });
  return store;
}

describe('skill memo reuse', () => {
  it('pays one ranking for two identical skill searches and never leaks bodies', async () => {
    const store = await skillStore();
    const registry = await createToolRegistry({ store, enqueuer: new NoopEnqueuer(), skills: MEMO_SKILLS });
    const search = registry.get('skill_search');
    if (search === undefined) throw new Error('skill_search missing');
    const ask = scoringAsk('pdf_lookup');
    const first = await search.execute({ query: 'find text inside pdf files' }, { ...context({ ask }, 'run-skill-1'), store });
    const second = await search.execute({ query: 'find text inside pdf files' }, { ...context({ ask }, 'run-skill-1'), store });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(textOf(first)).toContain('pdf_lookup');
    expect(textOf(first)).not.toContain('BODY:');
  });
});
