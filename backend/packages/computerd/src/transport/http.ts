/**
 * Error mapping and shared request helpers for computerd's routes. A Zod failure is a 400; a
 * \`ComputerdError\` keeps its stable code and status so the runner's client can translate it into a
 * tool result.
 */
import type { Context } from 'hono';
import { COMPUTER_RECREATED_HEADER, CONTROL_CHANGED_HEADER, ComputerdError } from '@agent-desktop/sandbox-adapters';
import type { Lifecycle } from '../modules/computers/lifecycle.js';
import { CONTROL_CHANGED_NOTE } from '../modules/control/gateway.js';
import { openRequestScope } from '../modules/control/request-scope.js';

const lifecycles = new WeakMap<Request, Lifecycle>();

/** Let `handle` recover a lost computer for this request (set once per request by the route app's middleware). */
export function bindLifecycle(c: Context, lifecycle: Lifecycle): void {
  lifecycles.set(c.req.raw, lifecycle);
}

export type Handler = (signal: AbortSignal) => Promise<Response>;

/** The requesting agent; required on every action. */
export function requireAgent(c: Context): string {
  const value = c.req.header('x-agent-id');
  if (!value) throw new ComputerdError('not_allowed', 'x-agent-id header is required');
  return value;
}

/** Run a handler with one AbortSignal tied to the request, mapping errors to the wire. */
export async function handle(c: Context, run: Handler): Promise<Response> {
  const controller = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => controller.abort());
  // The control gateway's admissions made by this request: released when it ends; control moving mid-action aborts it or marks its result.
  const scope = openRequestScope(controller);
  let controlChanged: boolean;
  try {
    const lifecycle = lifecycles.get(c.req.raw);
    if (!lifecycle) return await run(controller.signal);
    // A lost computer is replaced and the request runs again; the response says so, and the agent hears of it once.
    const { value, recreated } = await lifecycle.recovering(() => run(controller.signal), controller.signal);
    controlChanged = scope.finish();
    if (!recreated && !controlChanged) return value;
    const headers = new Headers(value.headers);
    if (recreated) headers.set(COMPUTER_RECREATED_HEADER, '1');
    if (controlChanged) headers.set(CONTROL_CHANGED_HEADER, '1');
    return new Response(value.body, { status: value.status, headers });
  } catch (error) {
    controlChanged = scope.finish();
    // The drain window ran out and the action was aborted: the agent is told control moved, not that the action "failed".
    if (controlChanged && controller.signal.aborted) return c.json({ code: 'user_control', message: CONTROL_CHANGED_NOTE, surface: 'screen', holder: 'user' }, 409);
    if (error instanceof ComputerdError) return c.json({ code: error.code, message: error.message, ...error.details }, error.httpStatus);
    if (isZodError(error)) return c.json({ code: 'failed', message: error.message }, 400);
    return c.json({ code: 'failed', message: error instanceof Error ? error.message : 'unknown error' }, 500);
  }
}

function isZodError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'ZodError';
}

