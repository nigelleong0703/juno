/**
 * Singapore land transport on LTA DataMall (https://datamall.lta.gov.sg, API user guide v6.x): bus arrivals, bus stop
 * lookup, train disruptions, car park lots and traffic incidents. The account key goes in the `AccountKey` header.
 * Each result is shaped into short text the agent can quote; times are Singapore time.
 */
import { limitOf, list, MINUTE, rec, sgTime, str, type SgContext, type SgTool } from './shared.js';

export const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice';
const PAGE_SIZE = 500;
const OPERATORS: Record<string, string> = { SBST: 'SBS Transit', SMRT: 'SMRT', TTS: 'Tower Transit', GAS: 'Go-Ahead' };
const LOADS: Record<string, string> = { SEA: 'seats available', SDA: 'standing room only', LSD: 'crowded, limited standing' };
const DECKS: Record<string, string> = { SD: 'single deck', DD: 'double deck', BD: 'bendy bus' };
const LOT_TYPES: Record<string, string> = { C: 'car', H: 'heavy vehicle', Y: 'motorcycle' };

/** One page-by-page read of an LTA list (500 rows per `$skip` step) until a page comes back short. */
async function allRows(ctx: SgContext, path: string, ttlMs: number, headers: Record<string, string>): Promise<Record<string, unknown>[]> {
  return ctx.memo(path, ttlMs, async () => {
    const rows: Record<string, unknown>[] = [];
    for (let skip = 0; skip < 20_000; skip += PAGE_SIZE) {
      const page = list(rec(await ctx.getJson(`${LTA_BASE}/${path}?$skip=${String(skip)}`, 0, headers)).value);
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return rows;
  });
}

const minutesAway = (eta: string, now: Date): string => {
  const minutes = Math.round((new Date(eta).getTime() - now.getTime()) / MINUTE);
  return minutes <= 0 ? 'arriving' : String(minutes) + ' min';
};

function describeBus(bus: Record<string, unknown>, now: Date): string | undefined {
  const eta = str(bus.EstimatedArrival);
  if (eta === undefined || Number.isNaN(new Date(eta).getTime())) return undefined;
  const details = [LOADS[str(bus.Load) ?? ''], str(bus.Feature) === 'WAB' ? 'wheelchair accessible' : undefined, DECKS[str(bus.Type) ?? '']].filter((part) => part !== undefined);
  return minutesAway(eta, now) + (details.length === 0 ? '' : ' (' + details.join(', ') + ')');
}

export function lta(headers: Record<string, string>): SgTool[] {
  const get = (ctx: SgContext, path: string, ttlMs: number): Promise<Record<string, unknown>> => ctx.getJson(`${LTA_BASE}/${path}`, ttlMs, headers).then(rec);
  return [
    {
      name: 'bus_arrival',
      title: 'Bus arrival times',
      description:
        'Singapore only. Live arrival times of the next 3 buses at a Singapore bus stop, with crowding, wheelchair access and deck type. Use for "when is my bus", "is bus 15 coming" or "how long until the next bus". Needs the 5-digit bus stop code (on the stop sign); if the user only gives a stop name or road, find the code with bus_stop_search first.',
      properties: {
        busStopCode: { type: 'string', description: '5-digit Singapore bus stop code, e.g. 83139.' },
        serviceNo: { type: 'string', description: 'Only this bus service number, e.g. 15 or 174A. Leave out for every service at the stop.' },
      },
      required: ['busStopCode'],
      async run(ctx, args) {
        const code = str(args.busStopCode);
        if (code === undefined || !/^\d{5}$/.test(code)) throw new Error('busStopCode must be a 5-digit bus stop code; use bus_stop_search to find it from a name');
        const service = str(args.serviceNo);
        const body = await get(ctx, `v3/BusArrival?BusStopCode=${code}${service === undefined ? '' : '&ServiceNo=' + encodeURIComponent(service)}`, 30_000);
        const now = ctx.now();
        const lines = list(body.Services).map((item) => {
          const buses = [item.NextBus, item.NextBus2, item.NextBus3].map((bus) => describeBus(rec(bus), now)).filter((bus) => bus !== undefined);
          const operator = OPERATORS[str(item.Operator) ?? ''];
          return `${str(item.ServiceNo) ?? '?'}${operator === undefined ? '' : ' (' + operator + ')'}: ${buses.length === 0 ? 'no estimate' : buses.join('; then ')}`;
        });
        const header = `Bus stop ${code}, as of ${sgTime(now.toISOString())} Singapore time`;
        return lines.length === 0 ? `${header}: no buses in service${service === undefined ? '' : ' for service ' + service} right now (or the stop code is wrong).` : header + ':\n' + lines.join('\n');
      },
    },
    {
      name: 'bus_stop_search',
      title: 'Find bus stops',
      description:
        'Singapore only. Find bus stop codes by stop name, landmark or road name (e.g. "Orchard", "Blk 123", "Clementi Ave 3"). Use before bus_arrival when the user does not know the 5-digit stop code.',
      properties: {
        query: { type: 'string', description: 'Part of the stop name or road name.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many stops (default 10).' },
      },
      required: ['query'],
      async run(ctx, args) {
        const query = str(args.query)?.toLowerCase();
        if (query === undefined) throw new Error('query is required');
        const stops = await allRows(ctx, 'BusStops', 24 * 60 * MINUTE, headers);
        const found = stops.filter((stop) => [stop.Description, stop.RoadName, stop.BusStopCode].some((field) => typeof field === 'string' && field.toLowerCase().includes(query)));
        const shown = found.slice(0, limitOf(args, 10, 25));
        if (shown.length === 0) return `No Singapore bus stop matches "${query}".`;
        return `${String(found.length)} stop(s) match "${query}"${found.length > shown.length ? ', showing ' + String(shown.length) : ''}:\n` + shown.map((stop) => `${String(stop.BusStopCode)}  ${String(stop.Description)} (${String(stop.RoadName)})`).join('\n');
      },
    },
    {
      name: 'train_alerts',
      title: 'MRT and LRT service alerts',
      description:
        'Singapore only. Current MRT/LRT train service status: whether any line is disrupted, which lines and stations are affected, and the operator message (free bus or shuttle help). Use for "is the MRT running normally", "any disruption on the East-West line" or when a commute looks delayed.',
      properties: {},
      async run(ctx) {
        const value = rec((await get(ctx, 'TrainServiceAlerts', 60_000)).value);
        const segments = list(value.AffectedSegments);
        const messages = list(value.Message).map((message) => `${str(message.Content) ?? ''} (${sgTime(message.CreatedDate)})`);
        if (value.Status !== 2 && segments.length === 0 && messages.length === 0) return 'All MRT and LRT lines are running normally.';
        const affected = segments.map((segment) => {
          const help = [segment.FreePublicBus ? 'free public bus' : undefined, segment.FreeMRTShuttle ? 'free MRT shuttle' : undefined].filter((part) => part !== undefined);
          return `${String(segment.Line)} line${str(segment.Direction) === undefined ? '' : ', towards ' + String(segment.Direction)}: ${str(segment.Stations) ?? 'stations not listed'}${help.length === 0 ? '' : ' (' + help.join(', ') + ')'}`;
        });
        return ['Train service disruption.', ...affected, ...messages].join('\n');
      },
    },
    {
      name: 'carpark_availability',
      title: 'Car park availability',
      description:
        'Singapore only. Live available parking lots (cars, motorcycles, heavy vehicles) at HDB, URA and LTA car parks, filtered by area or development name (e.g. "Marina", "Bedok Mall", "Orchard"). Use for "is there parking near ..." questions.',
      properties: {
        query: { type: 'string', description: 'Part of the area, development or location name. Give one: without it only the first car parks of the whole island come back.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many car parks (default 10).' },
      },
      async run(ctx, args) {
        const query = str(args.query)?.toLowerCase();
        const rows = await allRows(ctx, 'CarParkAvailabilityv2', 60_000, headers);
        const found = rows.filter((row) => query === undefined || [row.Area, row.Development].some((field) => typeof field === 'string' && field.toLowerCase().includes(query)));
        const byPark = new Map<string, { label: string; lots: string[] }>();
        for (const row of found) {
          const id = String(row.CarParkID ?? row.Development);
          const park = byPark.get(id) ?? { label: `${String(row.Development)}${str(row.Area) === undefined ? '' : ', ' + String(row.Area)} (${String(row.Agency)})`, lots: [] };
          park.lots.push(`${String(row.AvailableLots)} ${LOT_TYPES[str(row.LotType) ?? ''] ?? 'other'}`);
          byPark.set(id, park);
        }
        const parks = [...byPark.values()];
        const shown = parks.slice(0, limitOf(args, 10, 25));
        if (shown.length === 0) return query === undefined ? 'No car park data right now.' : `No Singapore car park matches "${query}".`;
        return `${String(parks.length)} car park(s)${query === undefined ? '' : ' match "' + query + '"'}${parks.length > shown.length ? ', showing ' + String(shown.length) + ' (give a more specific name to narrow)' : ''}; lots available:\n` + shown.map((park) => `${park.label}: ${park.lots.join(', ')}`).join('\n');
      },
    },
    {
      name: 'traffic_incidents',
      title: 'Traffic incidents',
      description: 'Singapore only. Current road incidents (accidents, breakdowns, roadworks, heavy traffic, diversions) island-wide. Use for "any jams or accidents" or before driving; optionally narrow by a road or expressway name such as "PIE" or "AYE".',
      properties: {
        query: { type: 'string', description: 'Part of a road or expressway name to keep only matching incidents.' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many incidents (default 10).' },
      },
      async run(ctx, args) {
        const query = str(args.query)?.toLowerCase();
        const found = list((await get(ctx, 'TrafficIncidents', MINUTE)).value).filter((item) => query === undefined || String(item.Message ?? '').toLowerCase().includes(query));
        const shown = found.slice(0, limitOf(args, 10, 25));
        if (shown.length === 0) return query === undefined ? 'No traffic incidents reported right now.' : `No reported traffic incident mentions "${query}".`;
        return `${String(found.length)} incident(s)${found.length > shown.length ? ', showing ' + String(shown.length) : ''}:\n` + shown.map((item) => `${String(item.Type)}: ${String(item.Message)}`).join('\n');
      },
    },
  ];
}
