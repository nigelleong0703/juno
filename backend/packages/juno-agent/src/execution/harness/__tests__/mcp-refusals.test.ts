/**
 * BACKEND §3.3d.4: a connected app's tool that the server refuses (HTTP 4xx) or that the arguments do not fit is an ordinary failed read for
 * the model, never an "uncertain action" for the person. Driven through the production loop with the real MCP tool adapter over a fake manager.
 */
import { describe, expect, it } from 'vitest';
import type { Tool } from '../../../contracts/index.js';
import type { McpManager, } from '../../../modules/mcp/manager.js';
import { McpToolRemovedError, type McpToolOutcome } from '../../../modules/mcp/client.js';
import { McpAuthError, McpProtocolError, refusalKind } from '../../../modules/mcp/protocol.js';
import { createMcpTool } from '../../../modules/mcp/registry.js';
import { AGENT, OWNER, call, driveTools, turn } from '../../../testing/drive-tools.js';
import { computeRoutesSchema, lookupWeatherSchema } from '../../../modules/tools/__tests__/grounding-lite-schemas.js';

// The schemas are the real ones Google's server lists: an object field is only a `$ref` into `$defs`.
const weatherSchema = lookupWeatherSchema;
const routesSchema = computeRoutesSchema;

const sunny: McpToolOutcome = { text: 'Sunny, 31C', parts: [{ type: 'text', text: 'Sunny, 31C' }], unsupported: [], isError: false, truncated: false };

/**
 * The Grounding Lite weather lookup, as the adapter builds it, over a manager that answers with `answer` and counts the calls that reached it.
 * `access: 'action'` is how it was classified before the catalog marked the app read-only (a fenced, never-replayed call); `'read'` is how it is now.
 */
function weatherTool(answer: () => Promise<McpToolOutcome>, access: 'read' | 'action' = 'read'): { tool: Tool; reached: () => number } {
  let reached = 0;
  const manager = { callTool: async () => { reached += 1; return answer(); } } as unknown as McpManager;
  const tool = createMcpTool({
    ownerId: OWNER, agentId: AGENT, connectionId: 'conn-maps', connectionName: 'Google Maps', catalogTruncated: false, manager, access, actions: 'allow',
    name: 'google_maps_lookup_weather', tool: { name: 'lookup_weather', description: 'Weather for a place and day', inputSchema: weatherSchema },
  });
  return { tool, reached: () => reached };
}

const good = { location: { address: 'Singapore' }, date: { day: 6, month: 11, year: 2026 } };

describe('which answers from a connected app are a definite refusal', () => {
  const http = (status: number): McpProtocolError => new McpProtocolError(status, 'MCP server returned HTTP ' + String(status), status);
  it.each([
    ['400 bad request', http(400), 'validation'],
    ['404', http(404), 'validation'],
    ['405', http(405), 'validation'],
    ['415', http(415), 'validation'],
    ['422', http(422), 'validation'],
    ['429 rate limited', http(429), 'external'],
    ['a refused credential (401/403)', new McpAuthError(403), 'permission'],
    ['JSON-RPC invalid params', new McpProtocolError(-32602, 'invalid params'), 'validation'],
    ['JSON-RPC method not found', new McpProtocolError(-32601, 'method not found'), 'validation'],
  ])('%s: it was refused, nothing ran', (_name, error, kind) => {
    expect(refusalKind(error)).toBe(kind);
  });

  it.each([
    ['500', http(500)],
    ['502', http(502)],
    ['504 gateway timeout', http(504)],
    ['408 request timeout', http(408)],
    ['a connection reset after the request was sent', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['the stream ending before the answer', new McpProtocolError(-32000, 'MCP SSE response ended before the matching message')],
  ])('%s: it may have run, so the outcome is unknown', (_name, error) => {
    expect(refusalKind(error)).toBeUndefined();
  });
});

describe('a connected app\'s tool through the run', () => {
  it('a server answering HTTP 400 is a failed call with the server\'s words: no card, the run goes on', async () => {
    const { tool } = weatherTool(() => Promise.reject(new McpProtocolError(400, 'MCP server returned HTTP 400: date must be an object', 400)), 'action');
    const { outcome, requests, steps, items } = await driveTools([turn('', call('c1', 'google_maps_lookup_weather', good)), turn('The date was rejected; I will say so.')], [tool]);
    expect(outcome).toBe('completed');
    expect(requests).toEqual([]);
    expect(steps[0]).toMatchObject({ status: 'failed', errorKind: 'validation' });
    expect(steps[0]?.output?.summary).toContain('date must be an object');
    expect(items.map((item) => (item as { markdown?: string }).markdown)).toEqual(['The date was rejected; I will say so.']);
  });

  it('objects sent as JSON text are decoded and reach the server as objects in one call; text of the wrong shape is still refused', async () => {
    const received: unknown[] = [];
    const manager = { callTool: async (request: { args: unknown }) => { received.push(request.args); return sunny; } } as unknown as McpManager;
    const tool = createMcpTool({
      ownerId: OWNER, agentId: AGENT, connectionId: 'conn-maps', connectionName: 'Google Maps', catalogTruncated: false, manager, access: 'read', actions: 'allow',
      name: 'google_maps_lookup_weather', tool: { name: 'lookup_weather', description: 'Weather for a place and day', inputSchema: weatherSchema },
    });
    const stringified = { location: JSON.stringify(good.location), date: JSON.stringify(good.date) };
    const { outcome, steps } = await driveTools([turn('', call('c1', 'google_maps_lookup_weather', stringified)), turn('It is sunny.')], [tool]);
    expect(outcome).toBe('completed');
    expect(steps[0]).toMatchObject({ status: 'completed' });
    expect(received).toEqual([good]);

    const wrongShape = await tool.execute({ location: '["Singapore"]', date: good.date }, { ownerId: OWNER, agentId: AGENT, store: {}, signal: new AbortController().signal } as never);
    expect(wrongShape.isError).toBe(true);
    expect(wrongShape.content.map((part) => (part.type === 'text' ? part.text : '')).join('')).toContain('location: received a string of JSON text');
    expect(received).toHaveLength(1);
  });

  it('the real compute_routes schema (objects only in $defs, the fields are $refs): origin and destination sent as JSON text reach Google as objects', async () => {
    const received: unknown[] = [];
    const manager = { callTool: async (request: { args: unknown }) => { received.push(request.args); return sunny; } } as unknown as McpManager;
    const tool = createMcpTool({
      ownerId: OWNER, agentId: AGENT, connectionId: 'conn-maps', connectionName: 'Google Maps', catalogTruncated: false, manager, access: 'read', actions: 'allow',
      name: 'google_maps_compute_routes', tool: { name: 'compute_routes', description: 'Routes', inputSchema: routesSchema },
    });
    const strings = { origin: '{"address": "190 Lor 6 Toa Payoh, Singapore"}', destination: '{"address": "Jurong East, Singapore"}', travelMode: 'TRANSIT' };
    const { outcome, steps } = await driveTools([turn('', call('c1', 'google_maps_compute_routes', strings)), turn('About 40 minutes.')], [tool]);
    expect(outcome).toBe('completed');
    expect(steps[0]).toMatchObject({ status: 'completed' });
    expect(received).toEqual([{ origin: { address: '190 Lor 6 Toa Payoh, Singapore' }, destination: { address: 'Jurong East, Singapore' }, travelMode: 'TRANSIT' }]);
  });

  it('a server refusing the arguments (HTTP 400) tells the model to correct them and call again; a 404 does not', async () => {
    const refuse = (status: number) => weatherTool(() => Promise.reject(new McpProtocolError(status, 'MCP server returned HTTP ' + String(status) + ': bad', status))).tool;
    const ctx = { ownerId: OWNER, agentId: AGENT, store: {}, signal: new AbortController().signal } as never;
    const textOf = async (tool: Tool): Promise<string> => (await tool.execute(good, ctx)).content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    expect(await textOf(refuse(400))).toContain('correct the arguments and call google_maps_lookup_weather again');
    expect(await textOf(refuse(404))).not.toContain('correct the arguments');
  });

  it('a tool the server no longer offers is a plain failure too', async () => {
    const { tool } = weatherTool(() => Promise.reject(new McpToolRemovedError('lookup_weather')));
    const { outcome, requests } = await driveTools([turn('', call('c1', 'google_maps_lookup_weather', good)), turn('Not available.')], [tool]);
    expect(outcome).toBe('completed');
    expect(requests).toEqual([]);
  });
});
