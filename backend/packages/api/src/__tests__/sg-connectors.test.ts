/** Singapore connectors: tool output shaping on fake upstreams, the internal-token gate, and key-dependent visibility. */
import { describe, expect, it } from 'vitest';
import { missingDefaultConnections } from '@agent-desktop/contracts/mcp';
import { resolveCatalog } from '../modules/connector-catalog.js';
import { CONNECTOR_CATALOG } from './builtin-catalog.js';
import { handleSgMcp, type SgMcpDeps } from '../modules/sg-mcp.js';
import { LTA_BASE } from '../modules/sg/transport.js';

const NOW = new Date('2026-10-19T06:05:00Z'); // 14:05 in Singapore
const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const stops = Array.from({ length: 501 }, (_, index) => ({ BusStopCode: String(10000 + index), RoadName: index === 500 ? 'Clementi Ave 3' : 'Some Rd', Description: index === 500 ? 'Clementi Stn' : 'Stop ' + String(index) }));
const carparks = [
  { CarParkID: '1', Area: 'Marina', Development: 'Suntec City', AvailableLots: 120, LotType: 'C', Agency: 'LTA' },
  { CarParkID: '1', Area: 'Marina', Development: 'Suntec City', AvailableLots: 8, LotType: 'Y', Agency: 'LTA' },
  { CarParkID: '2', Area: 'Bedok', Development: 'Bedok Mall', AvailableLots: 40, LotType: 'C', Agency: 'HDB' },
];

function upstream(): { fetchImpl: typeof fetch; calls: { url: string; headers: Headers }[] } {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const ok = (body: unknown) => Promise.resolve(Response.json(body));
    if (url.includes('/v3/BusArrival')) {
      return ok({ BusStopCode: '83139', Services: [{ ServiceNo: '15', Operator: 'GAS', NextBus: { EstimatedArrival: at(2.2), Load: 'SEA', Feature: 'WAB', Type: 'DD' }, NextBus2: { EstimatedArrival: at(9), Load: 'SDA', Feature: '', Type: 'DD' }, NextBus3: { EstimatedArrival: '' } }] });
    }
    if (url.includes('/BusStops')) return ok({ value: url.includes('$skip=0') ? stops.slice(0, 500) : stops.slice(500) });
    if (url.includes('/TrainServiceAlerts')) {
      return ok({ value: { Status: 2, AffectedSegments: [{ Line: 'EWL', Direction: 'Pasir Ris', Stations: 'EW5, EW6', FreePublicBus: 'EW5', FreeMRTShuttle: '', MRTShuttleDirection: '' }], Message: [{ Content: 'EWL delay, 15 min extra', CreatedDate: '2026-10-19T14:00:00+08:00' }] } });
    }
    if (url.includes('/CarParkAvailabilityv2')) return ok({ value: carparks });
    if (url.includes('/TrafficIncidents')) return ok({ value: [{ Type: 'Accident', Message: '(19/10)14:01 Accident on PIE (towards Tuas) after Bukit Timah Expressway' }] });
    return Promise.resolve(new Response('boom', { status: 500 }));
  };
  return { fetchImpl, calls };
}

async function call(deps: SgMcpDeps, service: string, method: string, params?: unknown, authorization = 'Bearer svc'): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request('https://gw.test/mcp/sg/' + service, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const response = await handleSgMcp(deps, service, request, [LTA_BASE]);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function run(deps: SgMcpDeps, service: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = (await call(deps, service, 'tools/call', { name, arguments: args })).body.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content[0]?.text ?? '', isError: result.isError === true };
}

const withKey = () => {
  const fake = upstream();
  return { fake, deps: { internalToken: 'svc', env: { LTA_ACCOUNT_KEY: 'lta-key' }, fetchImpl: fake.fetchImpl, now: () => NOW, cache: new Map() } satisfies SgMcpDeps };
};

describe('sg-transport', () => {
  it('shapes bus arrivals with minutes, load words and the account key header', async () => {
    const { deps, fake } = withKey();
    const { text } = await run(deps, 'sg-transport', 'bus_arrival', { busStopCode: '83139', serviceNo: '15' });
    expect(text).toContain('14:05');
    expect(text).toContain('15 (Go-Ahead): 2 min (seats available, wheelchair accessible, double deck); then 9 min (standing room only, double deck)');
    expect(fake.calls[0]?.url).toBe(LTA_BASE + '/v3/BusArrival?BusStopCode=83139&ServiceNo=15');
    expect(fake.calls[0]?.headers.get('accountkey')).toBe('lta-key');
    await run(deps, 'sg-transport', 'bus_arrival', { busStopCode: '83139', serviceNo: '15' });
    expect(fake.calls).toHaveLength(1); // cached for 30 s
    expect((await run(deps, 'sg-transport', 'bus_arrival', { busStopCode: 'abc' })).isError).toBe(true);
  });

  it('searches bus stops across both pages and caches the list', async () => {
    const { deps, fake } = withKey();
    expect((await run(deps, 'sg-transport', 'bus_stop_search', { query: 'clementi' })).text).toContain('10500  Clementi Stn (Clementi Ave 3)');
    await run(deps, 'sg-transport', 'bus_stop_search', { query: 'stop 3' });
    expect(fake.calls.filter((c) => c.url.includes('/BusStops'))).toHaveLength(2);
  });

  it('reports train alerts, car parks and traffic incidents in plain text', async () => {
    const { deps } = withKey();
    const alerts = (await run(deps, 'sg-transport', 'train_alerts')).text;
    expect(alerts).toContain('EWL line, towards Pasir Ris: EW5, EW6');
    expect(alerts).toContain('EWL delay, 15 min extra (14:00)');
    expect((await run(deps, 'sg-transport', 'carpark_availability', { query: 'suntec' })).text).toContain('Suntec City, Marina (LTA): 120 car, 8 motorcycle');
    expect((await run(deps, 'sg-transport', 'traffic_incidents', { query: 'pie' })).text).toContain('Accident: (19/10)14:01 Accident on PIE');
  });

  it('turns an upstream failure into a tool error, and a missing key hides the tools', async () => {
    const { deps } = withKey();
    const failing = { ...deps, fetchImpl: (() => Promise.resolve(new Response('', { status: 500 }))) as typeof fetch, cache: new Map() };
    expect(await run(failing, 'sg-transport', 'train_alerts')).toEqual({ text: 'The data source answered HTTP 500', isError: true });
    const rejected = { ...deps, fetchImpl: (() => Promise.resolve(new Response('', { status: 401 }))) as typeof fetch, cache: new Map() };
    expect((await call(rejected, 'sg-transport', 'tools/call', { name: 'train_alerts' })).status).toBe(200);
    const keyless = { ...deps, env: {} };
    expect((await run(keyless, 'sg-transport', 'train_alerts')).isError).toBe(true);
    const env = { BETTER_AUTH_URL: 'https://gw.test', INTERNAL_AGENTD_TOKEN: 'svc' };
    expect(resolveCatalog(CONNECTOR_CATALOG, 'https://gw.test', env).map((e) => e.id)).not.toContain('sg-transport');
    const shown = resolveCatalog(CONNECTOR_CATALOG, 'https://gw.test', { ...env, LTA_ACCOUNT_KEY: 'k' }).filter((e) => e.id.startsWith('sg-'));
    expect(shown.map((e) => [e.id, e.url])).toEqual([['sg-transport', 'https://gw.test/mcp/sg/sg-transport']]);
    expect(resolveCatalog(CONNECTOR_CATALOG, 'https://gw.test', env).map((e) => e.id)).not.toContain('sg-weather');
  });
});

describe('hosted gate and tool metadata', () => {
  it('answers only the internal token (403 otherwise) and marks every tool read-only with a title', async () => {
    const { deps } = withKey();
    for (const authorization of ['', 'Bearer wrong']) {
      expect(await call(deps, 'sg-transport', 'tools/list', undefined, authorization)).toEqual({ status: 403, body: { error: { code: 'FORBIDDEN' } } });
    }
    expect((await call({ ...deps, internalToken: '' }, 'sg-transport', 'tools/list', undefined, 'Bearer ')).status).toBe(403);
    for (const service of ['sg-transport']) {
      const tools = ((await call(deps, service, 'tools/list')).body.result as { tools: { title: string; description: string; annotations: { readOnlyHint: boolean } }[] }).tools;
      expect(tools.length).toBeGreaterThanOrEqual(4);
      for (const tool of tools) {
        expect(tool.title).not.toBe('');
        expect(tool.annotations.readOnlyHint).toBe(true);
        expect(tool.description).toContain('Singapore');
      }
    }
  });

  it('is connected by default through the gateway with the internal token', () => {
    const env = { BETTER_AUTH_URL: 'https://gw.test/', INTERNAL_AGENTD_TOKEN: 'svc' };
    expect(missingDefaultConnections('o', [], env).map((c) => c.catalogId)).toEqual([]);
    expect(missingDefaultConnections('o', [], { ...env, LTA_ACCOUNT_KEY: 'k' }).map((c) => c.catalogId)).toEqual(['sg-transport']);
  });
});
