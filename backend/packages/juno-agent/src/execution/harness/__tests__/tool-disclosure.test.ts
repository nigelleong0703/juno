import { describe, expect, it } from 'vitest';
import type { Tool } from '../../../contracts/index.js';
import { createToolLoadTool, createToolSearchTool, MCP_VISIBLE_BUDGET, parseToolCall, presentForModel, TOOL_CALL, TOOL_LOAD, TOOL_SEARCH } from '../../../modules/tools/tools/toolSearch.js';

function tool(name: string, mcp = false): Tool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    replay: 'safe',
    sideEffect: false,
    async execute() {
      return { content: [{ type: 'text', text: '' }] };
    },
    ...(mcp ? { mcp: true } : {}),
  } as Tool;
}

const mcpTools = (count: number): Tool[] => Array.from({ length: count }, (_, index) => tool('mcp_' + String(index), true));

describe('progressive tool disclosure', () => {
  it('hides connected-app tools by default even while the set is small; legacy keeps the old full view', () => {
    const tools = [tool('send_message'), tool(TOOL_SEARCH), tool(TOOL_CALL), ...mcpTools(5)];
    expect(presentForModel(tools, {}).map((entry) => entry.name)).toEqual(['send_message', TOOL_SEARCH, TOOL_CALL]);
    expect(presentForModel(tools, { TOOL_DISCLOSURE: 'legacy' }).map((entry) => entry.name)).toEqual(['send_message', 'mcp_0', 'mcp_1', 'mcp_2', 'mcp_3', 'mcp_4']);
  });

  it('hides connected-app tools by default no matter the size; only legacy caps at 24', () => {
    const tools = [tool('send_message'), tool(TOOL_SEARCH), tool(TOOL_CALL), ...mcpTools(MCP_VISIBLE_BUDGET + 10)];
    expect(presentForModel(tools, {}).filter((entry) => entry.name.startsWith('mcp_'))).toHaveLength(0);
    const legacy = presentForModel(tools, { TOOL_DISCLOSURE: 'legacy' }).map((entry) => entry.name);
    expect(legacy).toContain('send_message');
    expect(legacy).toContain(TOOL_SEARCH);
    expect(legacy).toContain(TOOL_CALL);
    expect(legacy.filter((name) => name.startsWith('mcp_'))).toHaveLength(MCP_VISIBLE_BUDGET);
  });

  it('hides deferred non-core builtins by default while unmarked stubs stay visible; off shows everything directly', () => {
    const deferred = tool('memory_search');
    deferred.deferLoading = true;
    const tools = [tool('send_message'), tool(TOOL_SEARCH), tool(TOOL_CALL), deferred, tool('custom_stub')];
    const shown = presentForModel(tools, {}).map((entry) => entry.name);
    expect(shown).toContain('send_message');
    expect(shown).toContain('custom_stub');
    expect(shown).not.toContain('memory_search');
    const off = presentForModel(tools, { TOOL_DISCLOSURE: 'off' }).map((entry) => entry.name);
    expect(off).toContain('memory_search');
    expect(off).toContain('custom_stub');
    expect(off).not.toContain(TOOL_SEARCH);
  });

  it('treats unset and on as compact, legacy and off as the old direct views', () => {
    const tools = [tool(TOOL_SEARCH), tool(TOOL_CALL), ...mcpTools(3)];
    for (const env of [{}, { TOOL_DISCLOSURE: 'on' }]) {
      expect(presentForModel(tools, env).map((entry) => entry.name)).toEqual([TOOL_SEARCH, TOOL_CALL]);
    }
    expect(presentForModel(tools, { TOOL_DISCLOSURE: 'legacy' }).map((entry) => entry.name)).not.toContain(TOOL_SEARCH);
    expect(presentForModel(tools, { TOOL_DISCLOSURE: 'off' }).map((entry) => entry.name)).not.toContain(TOOL_SEARCH);
  });

  it('reads a proxy call and refuses a malformed one', () => {
    expect(parseToolCall({ name: 'gmail_search', arguments: { q: 'x' } })).toEqual({ name: 'gmail_search', arguments: { q: 'x' } });
    expect(parseToolCall({ name: 'gmail_search' })).toEqual({ name: 'gmail_search', arguments: {} });
    expect(parseToolCall({ arguments: {} })).toBeNull();
    expect(parseToolCall({ name: '' })).toBeNull();
  });
});

describe('tool_search and tool_load model-facing parameters', () => {
  it('gives each finder one required argument, with no "supply one of" rule', () => {
    const source = { all: async () => [], visible: async () => new Set<string>() };
    const search = createToolSearchTool(source).parameters;
    expect(search['properties']).toMatchObject({ query: expect.any(Object), namespace: expect.any(Object) });
    expect(search['required']).toEqual(['query']);
    expect(search['anyOf']).toBeUndefined();
    const load = createToolLoadTool(source).parameters;
    expect(load['properties']).toMatchObject({ names: { type: 'array', minItems: 1, maxItems: 10 } });
    expect(load['required']).toEqual(['names']);
  });

  it('keeps all three discovery tools out of the direct views and in the compact core', () => {
    const tools = [tool('send_message'), tool(TOOL_SEARCH), tool(TOOL_LOAD), tool(TOOL_CALL)];
    expect(presentForModel(tools, {}).map((entry) => entry.name)).toEqual(['send_message', TOOL_SEARCH, TOOL_LOAD, TOOL_CALL]);
    expect(presentForModel(tools, { TOOL_DISCLOSURE: 'off' }).map((entry) => entry.name)).toEqual(['send_message']);
  });
});
