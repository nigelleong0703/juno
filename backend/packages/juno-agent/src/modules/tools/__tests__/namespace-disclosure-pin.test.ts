import { describe, expect, it } from 'vitest';
import type { Tool } from '../../../contracts/index.js';
import { createMemoryStore, NoopEnqueuer } from '../../../testing/store.js';
import { createToolRegistry } from '../index.js';
import { presentForModel } from '../tools/toolSearch.js';

function mcpTool(name: string): Tool {
  return { name, mcp: true, description: 'A connected-app operation', parameters: { type: 'object' },
    replay: 'safe', sideEffect: false, execute: async () => ({ content: [] }) };
}

describe('namespace disclosure lead acceptance', () => {
  it('does not advertise the first MCP tools just because they arrived first', () => {
    const shown = presentForModel([mcpTool('notion_search'), mcpTool('gmail_read')], {});
    expect(shown.filter((tool) => tool.mcp === true)).toHaveLength(0);
  });

  it('does not declare browser and computer actions up front: the directory names the families, tool_search returns them', async () => {
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer(), computer: () => { throw new Error('disclosure must not create a computer'); } });
    const shown = presentForModel(await registry.forAgent('agent'), {});
    const names = shown.map(tool => tool.name);
    expect(names.filter((name) => name.startsWith('browser.') || name.startsWith('computer.'))).toEqual([]);
    expect(registry.get('browser.click')).toBeDefined();
    expect(registry.get('computer.screenshot')).toBeDefined();
    expect(names).not.toContain('files.edit');
    expect(new Set(names).size).toBe(names.length);
    const discovered = { ...mcpTool('notion_read'), deferLoading: false };
    const refreshed = presentForModel([discovered, ...(await registry.forAgent('agent')).reverse()], {});
    expect(refreshed.slice(0, names.length).map(tool => tool.name)).toEqual(names);
    expect(refreshed.at(-1)?.name).toBe('notion_read');
  });

  it('keeps a small model-facing core while the full production registry remains available', async () => {
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer() });
    const all = await registry.forAgent('agent');
    const shown = presentForModel(all, {});
    expect(all.length).toBeGreaterThan(30);
    expect(shown.length).toBeLessThanOrEqual(16);
    expect(shown.map((tool) => tool.name)).toEqual(expect.arrayContaining(['tool_search', 'tool_call', 'skill_read', 'skill_search', 'send_message', 'web_fetch', 'subagent_start']));
    expect(registry.get('memory_search')).toBeDefined();
  });
});
