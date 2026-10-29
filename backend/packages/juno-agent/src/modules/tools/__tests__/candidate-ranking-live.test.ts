import { describe, expect, it } from 'vitest';
import type { Tool, ToolContext } from '../../../contracts/index.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createJevSystemOne } from '../../../execution/brain/system-one-jev.js';
import { agentDoc, wakeFor } from '../../../execution/brain/__tests__/agent-resources.fixtures.js';
import { createFakeSkills } from '../../../testing/skills.js';
import { runWithOwner } from '../../../owner-context.js';
import { createToolRegistry } from '../index.js';
import { createToolSearchTool } from '../tools/toolSearch.js';

const live = process.env['RUN_JEV_RANKING_LIVE'] === '1';
const OWNER = 'owner-1';
const AGENT = 'agent-ranking-live';

function endpoint() {
  const baseUrl = process.env['SYSTEM_ONE_BASE_URL'];
  const apiKey = process.env['SYSTEM_ONE_API_KEY'];
  const modelId = process.env['SYSTEM_ONE_MODEL_ID'];
  if (!baseUrl || !apiKey || !modelId) throw new Error('Configure SYSTEM_ONE_BASE_URL/API_KEY/MODEL_ID for explicit live qualification');
  return createJevSystemOne({ baseUrl, apiKey, modelId });
}

function context(): ToolContext {
  return {
    ownerId: OWNER, agentId: AGENT, conversationId: 'conv-1', runId: 'ranking-live',
    store: createMemoryStore(), blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: wakeFor(AGENT), signal: AbortSignal.timeout(30_000), step: async (_name, fn) => fn(),
    systemOne: endpoint(),
  };
}

const metadata = [
  ['archive_mail', 'Archive email messages from the inbox.'],
  ['search_notes', 'Search the text of previously saved personal notes.'],
  ['create_calendar_event', 'Add a new event with time and participants to the calendar.'],
  ['list_calendar_events', 'Look up existing events and meetings in the calendar.'],
  ['create_task', 'Add a new item to the todo list.'],
  ['read_task', 'Look up an existing todo item.'],
];

function tools(): Tool[] {
  return metadata.map(([name = '', description = '']) => ({
    name, description, parameters: { type: 'object' }, replay: 'safe', sideEffect: false,
    execute: async () => { throw new Error('Discovery must never execute a candidate'); },
  }));
}

describe.runIf(live)('Jev candidate ranking real endpoint qualification', () => {
  it('ranks tool and selected-skill metadata for Chinese requests', async () => {
    const ctx = context();
    const search = createToolSearchTool({ all: async () => tools(), visible: async () => new Set() });
    const cases = [
      ['找到我以前存的那条笔记', 'search_notes'],
      ['查看我明天有什么会议', 'list_calendar_events'],
      ['在待办里加一项：买牛奶', 'create_task'],
    ] as const;
    for (const [query = '', expected = ''] of cases) {
      const started = performance.now();
      const result = await search.execute({ query }, ctx);
      expect(result.details?.['ranking']).toBe('system-one');
      const text = result.content.flatMap((item) => item.type === 'text' ? [item.text] : []).join('\n');
      console.info(JSON.stringify({ kind: 'tool', query, expected, elapsedMs: Math.round(performance.now() - started), first: text.split('\n')[0] }));
      expect(text.split('\n')[0]).toContain(expected);
    }

    await runWithOwner(OWNER, async () => {
      await ctx.store.put('agents', agentDoc(AGENT, ['skill-edit', 'skill-create', 'skill-calendar']));
      const skills = createFakeSkills([
        { id: 'skill-edit', name: 'Edit slides', description: 'Modify an existing presentation deck while preserving its template.', instructions: 'PRIVATE-EDIT-INSTRUCTIONS', ownerId: OWNER },
        { id: 'skill-create', name: 'Create slides', description: 'Create a new presentation from a topic and outline.', instructions: 'PRIVATE-CREATE-INSTRUCTIONS', ownerId: OWNER },
        { id: 'skill-calendar', name: 'Calendar planning', description: 'Plan meetings and calendar events.', instructions: 'PRIVATE-CALENDAR-INSTRUCTIONS', ownerId: OWNER },
      ]);
      const registry = await createToolRegistry({ store: ctx.store, enqueuer: ctx.enqueuer, skills });
      const skillSearch = registry.get('skill_search');
      if (!skillSearch) throw new Error('Production skill_search is missing');
      for (const [query, expected, other] of [
        ['用现有的公司模板修改这份演示文稿', 'Edit slides', 'Create slides'],
        ['从零做一份介绍新产品的演示文稿', 'Create slides', 'Edit slides'],
      ] as const) {
        const started = performance.now();
        const result = await skillSearch.execute({ query }, ctx);
        expect(result.details?.['ranking']).toBe('system-one');
        const text = result.content.flatMap((item) => item.type === 'text' ? [item.text] : []).join('\n');
        console.info(JSON.stringify({ kind: 'skill', query, expected, elapsedMs: Math.round(performance.now() - started), result: text }));
        expect(text).toContain(expected);
        if (text.includes(other)) expect(text.indexOf(expected)).toBeLessThan(text.indexOf(other));
        expect(text).not.toContain('PRIVATE-');
      }
    });
  }, 45_000);
});
