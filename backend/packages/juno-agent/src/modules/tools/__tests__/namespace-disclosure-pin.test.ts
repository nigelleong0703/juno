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

  it('offers curated browser and computer actions directly while rare tools stay deferred', async () => {
    const registry = await createToolRegistry({ store: createMemoryStore(), enqueuer: new NoopEnqueuer(), computer: () => { throw new Error('disclosure must not create a computer'); } });
    const shown = presentForModel(await registry.forAgent('agent'), {});
    const names = shown.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['browser.advance', 'browser.navigate', 'browser.snapshot', 'browser.click', 'browser.type', 'browser.fill', 'browser.get_text', 'browser.dialog', 'computer.screenshot', 'computer.click', 'computer.type', 'computer.key', 'computer.scroll']));
    expect(names).not.toContain('computer.record_audio');
    expect(names).not.toContain('browser.new_tab');
    expect(names).not.toContain('files.read');
    expect(shown.find(tool => tool.name === 'browser.advance')?.parameters).toMatchObject({ required: ['goal', 'stage'] });
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
    expect(shown.length).toBeLessThanOrEqual(10);
    expect(shown.map((tool) => tool.name)).toEqual(expect.arrayContaining(['tool_search', 'tool_call', 'skill_read', 'skill_search', 'send_message']));
    expect(registry.get('memory_search')).toBeDefined();
  });
});
