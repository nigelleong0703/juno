// The original jev-browser MCP bridge. It is inert unless the operator explicitly enables it and
// the calling owner resolves a real System One endpoint. Fast-model emulation never qualifies.
import { createHash } from 'node:crypto';
import type { Store } from '../contracts/index.js';
import { readSystemOneEnv, resolveSystemOne, type SystemOneSelection } from './brain/system-one.js';
import type { BackendConfig } from './config.js';
import { createModelFetch } from '../modules/tools/net/guardedFetch.js';

export const JEV_CONNECTION_PREFIX = 'con-jev-browser-';
export const JEV_BROWSER_MCP_COMMAND = '/usr/bin/python3';
export const JEV_BROWSER_MCP_WRAPPER = '/opt/juno/jev-browser/agent_jev_supervise.py';
export const JEV_PLACEHOLDER_KEY = 'placeholder-juno-relay-not-a-key';

export function isJevBrowserMcpEnabled(env: Record<string, string | undefined>): boolean {
  return env['JEV_BROWSER_MCP_ENABLED'] === '1';
}

export function jevConnectionIdForOwner(ownerId: string): string {
  return JEV_CONNECTION_PREFIX + createHash('sha256').update(ownerId, 'utf8').digest('hex').slice(0, 16);
}

export function isJevConnectionId(id: unknown): boolean {
  return typeof id === 'string' && id.indexOf(JEV_CONNECTION_PREFIX) === 0;
}

export async function resolveJevNative(store: Store, ownerId: string, config: BackendConfig): Promise<SystemOneSelection | undefined> {
  if (config.JEV_BROWSER_MCP_ENABLED !== '1') return undefined;
  return resolveSystemOne(store, ownerId, readSystemOneEnv(config));
}

export interface JevRelayContext {
  store: Store;
  config: BackendConfig;
  ownerId: string;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRelayParams(params: unknown): { state: unknown; questions: Record<string, unknown> } {
  if (!isRecord(params)) throw new Error('relay refused: invalid params');
  const keys = Object.keys(params).sort();
  if (keys.length !== 2 || keys[0] !== 'questions' || keys[1] !== 'state') {
    throw new Error('relay refused: only state and questions are accepted');
  }
  const questions = params['questions'];
  if (!isRecord(questions) || Object.keys(questions).length === 0) throw new Error('relay refused: invalid questions');
  return { state: params['state'], questions };
}

/** Send only the original native decision fields; endpoint, model and key stay on the backend. */
export async function handleJevRelay(ctx: JevRelayContext, params: unknown): Promise<{ status: number; body: unknown }> {
  const parsed = parseRelayParams(params);
  const selection = await resolveJevNative(ctx.store, ctx.ownerId, ctx.config);
  if (selection === undefined) throw new Error('relay refused: no real native for owner');
  const base = selection.endpoint.baseUrl.replace(/\/+$/, '');
  const url = base.endsWith('/v1/systemone') ? base : base + '/v1/systemone';
  const body = JSON.stringify({ model: selection.endpoint.modelId, state: parsed.state, questions: parsed.questions });
  if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) throw new Error('relay refused: request too large');
  const fetchFn = selection.source === 'chosen' ? createModelFetch() : fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('relay timed out')), 60 * 1000);
  timer.unref?.();
  const outer = ctx.signal;
  const onOuter = () => controller.abort(outer?.reason);
  if (outer !== undefined) {
    if (outer.aborted) controller.abort(outer.reason);
    else outer.addEventListener('abort', onOuter, { once: true });
  }
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + selection.endpoint.apiKey },
      body,
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) throw new Error('relay response too large');
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      throw new Error('relay: upstream invalid JSON');
    }
    return { status: response.status, body: json };
  } finally {
    clearTimeout(timer);
    if (outer !== undefined) outer.removeEventListener('abort', onOuter);
  }
}

export function jevMcpServerConfig(): { transport: 'stdio'; command: string; args: string[]; env: Record<string, string> } {
  return {
    transport: 'stdio',
    command: JEV_BROWSER_MCP_COMMAND,
    args: [JEV_BROWSER_MCP_WRAPPER],
    env: { JEV_BROWSER_NO_INSTALL: '1', TYPESAFE_API_KEY: JEV_PLACEHOLDER_KEY, JEV_BROWSER_MCP: '1' },
  };
}
