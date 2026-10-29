/**
 * The Hevy MCP server this gateway hosts at HEVY_MCP_PATH. Hevy has no MCP server of its own, only a public REST API
 * (https://api.hevyapp.com/docs, needs Hevy Pro) keyed by the owner's own API key. The key is the caller's: the
 * agent's MCP client sends it in the `api-key` header (sealed with the connection, modules/connectors.ts) and each
 * tool call forwards it to Hevy as that header. We hold no state, never store or log it and never put it in a
 * result. Without a key `initialize` and `tools/list` still work and `tools/call` answers with a tool error that
 * says to connect Hevy (not HTTP 401: that would start an OAuth flow the client cannot finish). Writing tools say
 * so (readOnlyHint false), so they follow the connector's level and ask first.
 */

import { HEVY_KEY_HEADER, HEVY_MCP_PATH } from '@agent-desktop/contracts/mcp';

export { HEVY_KEY_HEADER, HEVY_MCP_PATH };
const HEVY_API = 'https://api.hevyapp.com/v1';
const PROTOCOL_VERSION = '2025-06-18';
/** Hevy has no name filter on exercise templates, so a search pages through them: at most this many pages of 100. */
const SEARCH_PAGES = 20;

export interface HevyMcpDeps {
  fetchImpl?: typeof fetch;
  /** Tests point this at a fake Hevy. */
  apiBase?: string;
}

type Args = Record<string, unknown>;
type Json = Record<string, unknown>;
type HevyApi = (path: string, query?: Record<string, string>, send?: { method: 'POST'; body: unknown }) => Promise<Json>;

interface HevyTool {
  name: string;
  title: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  writes?: boolean;
  run(api: HevyApi, args: Args): Promise<unknown>;
}

/** The tool's answer when Hevy refuses the key; the message never repeats the key. */
class KeyRejected extends Error {}

const num = (value: unknown, fallback: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.trunc(value))) : fallback;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const list = (value: unknown): Json[] => (Array.isArray(value) ? (value as Json[]) : []);

const PAGING = {
  page: { type: 'integer', minimum: 1, description: 'Page number, starting at 1 (default 1).' },
  pageSize: { type: 'integer', minimum: 1, maximum: 10, description: 'Results per page, at most 10 (default 10).' },
};

const setOf = (set: Json) => ({ type: set.type, weight_kg: set.weight_kg, reps: set.reps, distance_meters: set.distance_meters, duration_seconds: set.duration_seconds, rpe: set.rpe });
const workoutOf = (workout: Json) => ({
  id: workout.id,
  title: workout.title,
  description: workout.description,
  start_time: workout.start_time,
  end_time: workout.end_time,
  exercises: list(workout.exercises).map((exercise) => ({
    title: exercise.title,
    exercise_template_id: exercise.exercise_template_id,
    notes: exercise.notes,
    sets: list(exercise.sets).map(setOf),
  })),
});
const templateOf = (template: Json) => ({ id: template.id, title: template.title, type: template.type, primary_muscle_group: template.primary_muscle_group, is_custom: template.is_custom });
const pageOf = (body: Json, key: string, shape: (item: Json) => unknown) => ({ page: body.page, page_count: body.page_count, [key]: list(body[key]).map(shape) });

const SET_PROPERTIES = {
  type: { type: 'string', enum: ['warmup', 'normal', 'failure', 'dropset'], description: 'Kind of set (default normal).' },
  weight_kg: { type: 'number', description: 'Weight in kilograms.' },
  reps: { type: 'integer', description: 'Repetitions.' },
  distance_meters: { type: 'integer', description: 'Distance in meters.' },
  duration_seconds: { type: 'integer', description: 'Duration in seconds.' },
  rpe: { type: 'number', enum: [6, 7, 7.5, 8, 8.5, 9, 9.5, 10], description: 'Rating of perceived exertion.' },
};

export const HEVY_TOOLS: HevyTool[] = [
  {
    name: 'list_workouts',
    title: 'List workouts',
    description: "List the owner's logged workouts, newest first, with their exercises and sets. Use page to go further back.",
    properties: PAGING,
    run: async (api, args) => pageOf(await api('/workouts', { page: String(num(args.page, 1, 100000)), pageSize: String(num(args.pageSize, 10, 10)) }), 'workouts', workoutOf),
  },
  {
    name: 'get_workout',
    title: 'Get a workout',
    description: 'Get one logged workout with all its exercises and sets.',
    properties: { workoutId: { type: 'string', description: 'Workout id from list_workouts.' } },
    required: ['workoutId'],
    run: async (api, args) => workoutOf(await api('/workouts/' + encodeURIComponent(str(args.workoutId) ?? ''))),
  },
  {
    name: 'workout_count',
    title: 'Count workouts',
    description: 'How many workouts the owner has logged in total.',
    properties: {},
    run: async (api) => ({ workout_count: (await api('/workouts/count')).workout_count }),
  },
  {
    name: 'list_routines',
    title: 'List routines',
    description: "List the owner's saved workout routines (templates to start a workout from).",
    properties: PAGING,
    run: async (api, args) => pageOf(await api('/routines', { page: String(num(args.page, 1, 100000)), pageSize: String(num(args.pageSize, 10, 10)) }), 'routines', (routine) => ({
      id: routine.id,
      title: routine.title,
      notes: routine.notes,
      exercises: list(routine.exercises).map((exercise) => ({ title: exercise.title, exercise_template_id: exercise.exercise_template_id, sets: list(exercise.sets).length })),
    })),
  },
  {
    name: 'list_exercise_templates',
    title: 'Find exercises',
    description: 'List or search the exercises Hevy knows (built-in and custom). Use search to find an exercise by name, and its id for create_workout.',
    properties: {
      search: { type: 'string', description: 'Part of the exercise name, e.g. "bench press". Without it, a page of exercises is listed.' },
      page: { type: 'integer', minimum: 1, description: 'Page number when not searching (default 1, 100 per page).' },
    },
    run: async (api, args) => {
      const search = str(args.search)?.toLowerCase();
      if (search === undefined) return pageOf(await api('/exercise_templates', { page: String(num(args.page, 1, 100000)), pageSize: '100' }), 'exercise_templates', templateOf);
      const found: unknown[] = [];
      for (let page = 1; page <= SEARCH_PAGES && found.length < 25; page += 1) {
        const body = await api('/exercise_templates', { page: String(page), pageSize: '100' });
        for (const template of list(body.exercise_templates)) if (String(template.title ?? '').toLowerCase().includes(search) && found.length < 25) found.push(templateOf(template));
        if (typeof body.page_count !== 'number' || page >= body.page_count) break;
      }
      return { exercise_templates: found };
    },
  },
  {
    name: 'create_workout',
    title: 'Log a workout',
    description: 'Log a finished workout. Each exercise needs an exercise_template_id from list_exercise_templates; times are ISO 8601.',
    properties: {
      title: { type: 'string', description: 'Workout title.' },
      description: { type: 'string', description: 'Optional notes about the workout.' },
      start_time: { type: 'string', description: 'When it started, ISO 8601, e.g. 2026-10-19T07:00:00Z.' },
      end_time: { type: 'string', description: 'When it ended, ISO 8601.' },
      is_private: { type: 'boolean', description: 'Hide it from followers (default false).' },
      exercises: {
        type: 'array',
        description: 'The exercises done, in order.',
        items: {
          type: 'object',
          properties: {
            exercise_template_id: { type: 'string', description: 'Exercise id from list_exercise_templates.' },
            superset_id: { type: 'integer', description: 'Same number on exercises done as one superset.' },
            notes: { type: 'string' },
            sets: { type: 'array', items: { type: 'object', properties: SET_PROPERTIES } },
          },
          required: ['exercise_template_id', 'sets'],
        },
      },
    },
    required: ['title', 'start_time', 'end_time', 'exercises'],
    writes: true,
    run: async (api, args) => {
      const exercises = list(args.exercises);
      if (str(args.title) === undefined || str(args.start_time) === undefined || str(args.end_time) === undefined || exercises.length === 0) {
        throw new Error('create_workout needs title, start_time, end_time and at least one exercise');
      }
      const workout = {
        title: args.title,
        description: str(args.description) ?? null,
        start_time: args.start_time,
        end_time: args.end_time,
        is_private: args.is_private === true,
        exercises: exercises.map((exercise) => ({
          exercise_template_id: exercise.exercise_template_id,
          superset_id: typeof exercise.superset_id === 'number' ? exercise.superset_id : null,
          notes: str(exercise.notes) ?? null,
          sets: list(exercise.sets).map((set) => ({ type: str(set.type) ?? 'normal', weight_kg: set.weight_kg ?? null, reps: set.reps ?? null, distance_meters: set.distance_meters ?? null, duration_seconds: set.duration_seconds ?? null, rpe: set.rpe ?? null })),
        })),
      };
      const created = list((await api('/workouts', {}, { method: 'POST', body: { workout } })).workout)[0];
      return created === undefined ? { created: true } : workoutOf(created);
    },
  },
];

function hevyApi(deps: HevyMcpDeps, key: string): HevyApi {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (path, query = {}, send) => {
    const url = new URL((deps.apiBase ?? HEVY_API) + path);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await fetchImpl(url, {
      ...(send === undefined ? {} : { method: send.method, body: JSON.stringify(send.body) }),
      headers: { [HEVY_KEY_HEADER]: key, accept: 'application/json', ...(send === undefined ? {} : { 'content-type': 'application/json' }) },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new KeyRejected();
    }
    const body = (await response.json().catch(() => ({}))) as Json;
    if (!response.ok) {
      const reason = str(body.error) ?? str(body.message);
      throw new Error('Hevy ' + String(response.status) + (reason === undefined ? '' : ': ' + reason));
    }
    return body;
  };
}

const rpc = (id: unknown, result: unknown): Response => Response.json({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string): Response => Response.json({ jsonrpc: '2.0', id, error: { code, message } });
const toolError = (id: unknown, text: string): Response => rpc(id, { content: [{ type: 'text', text }], isError: true });

/** Streamable HTTP, JSON responses only (no sessions, no server-sent events): initialize, tools/list, tools/call, ping. */
export async function handleHevyMcp(deps: HevyMcpDeps, request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const message = (await request.json().catch(() => undefined)) as { id?: unknown; method?: unknown; params?: Record<string, unknown> } | undefined;
  if (typeof message !== 'object' || message === null || typeof message.method !== 'string') return rpcError(null, -32600, 'Invalid request');
  if (message.id === undefined) return new Response(null, { status: 202 });
  switch (message.method) {
    case 'initialize':
      return rpc(message.id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'juno-hevy', version: '1.0.0' } });
    case 'ping':
      return rpc(message.id, {});
    case 'tools/list':
      return rpc(message.id, {
        tools: HEVY_TOOLS.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: { type: 'object', properties: tool.properties, ...(tool.required === undefined ? {} : { required: tool.required }) },
          annotations: { title: tool.title, readOnlyHint: tool.writes !== true, ...(tool.writes === true ? { destructiveHint: false } : {}), openWorldHint: true },
        })),
      });
    case 'tools/call': {
      const tool = HEVY_TOOLS.find((candidate) => candidate.name === message.params?.name);
      if (tool === undefined) return rpcError(message.id, -32602, 'Unknown tool');
      const key = request.headers.get(HEVY_KEY_HEADER)?.trim() ?? '';
      if (key === '') return toolError(message.id, 'Hevy is not connected: connect Hevy with your Hevy API key (Hevy Pro, hevy.com settings, Developer).');
      const args = message.params?.arguments;
      try {
        const result = await tool.run(hevyApi(deps, key), typeof args === 'object' && args !== null ? (args as Args) : {});
        return rpc(message.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (error) {
        if (error instanceof KeyRejected) return toolError(message.id, 'Hevy rejected the API key (it needs Hevy Pro). Reconnect Hevy with a valid key.');
        return toolError(message.id, error instanceof Error ? error.message : 'The call failed');
      }
    }
    default:
      return rpcError(message.id, -32601, 'Method not found');
  }
}
