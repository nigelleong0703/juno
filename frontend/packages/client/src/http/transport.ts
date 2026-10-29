/**
 * Shared HTTP transport behind every ApiClient endpoint module: bearer auth, JSON bodies,
 * zod-validated responses, error mapping and empty-204 handling.
 */

import { z } from 'zod';

import type { ListResult } from '../contracts.js';
import { softenUiDocs } from './ui-docs.js';

export interface HttpClientOptions {
  baseUrl: string;
  /** Bearer token; omitted sends no Authorization header (verify harness and token-free probes). */
  getToken?: () => Promise<string> | string;
  fetch?: typeof globalThis.fetch;
  /**
   * Called when the event stream receives an `event: reset` frame — the server can no longer replay
   * from the client's cursor, so the client restarts from the beginning. Invalid/unknown frames are
   * dropped silently and never reach `subscribe` handlers (the `AgentEvent` schema is not widened).
   */
  onReset?: () => void;
  /** Which app this is; the event stream reports it so the agent knows where the user is. */
  clientKind?: 'web' | 'desktop' | 'ios';
}

export interface HttpError extends Error {
  status: number;
  code: string;
  /** Per-field reasons of a 400 (`error.fields`), keyed by field id. */
  fields?: Record<string, string>;
  /** A 429 that says when to retry (`error.retryAfterSec`). */
  retryAfterSec?: number;
}

export type ZodSchema<T> = z.ZodType<T>;

/** Narrow an unknown thrown value to an HTTP error carrying `status`. */
export function hasStatus(error: unknown, status: number): error is HttpError {
  if (typeof error !== 'object' || error === null) return false;
  if (!('status' in error)) return false;
  return error.status === status;
}

/**
 * The request/parse surface endpoint modules build on. `request` is overloaded: pass a schema to
 * get a validated, typed value back; omit it for a raw JSON payload (or `undefined` on 204).
 */
export interface HttpTransport {
  readonly baseUrl: string;
  /** `headers` are extra request headers (the control epoch a take-over saw). */
  request<T>(path: string, method: string, body: unknown, schema: ZodSchema<T>, headers?: Record<string, string>): Promise<T>;
  request(path: string, method: string, body?: unknown): Promise<unknown>;
  /**
   * GET a list. An item the client cannot read only because it holds a value this version does not know (an enum value a newer
   * server added) is skipped instead of failing the whole list; any other malformed item still throws.
   */
  list<T>(path: string, schema: ZodSchema<T>): Promise<ListResult<T>>;
  /** GET a text body as is (the audit CSV export); errors map like every other request. */
  text(path: string): Promise<string>;
  parse<T>(schema: ZodSchema<T>, data: unknown): T;
}

export function createTransport(opts: HttpClientOptions): HttpTransport {
  const fetch_ = opts.fetch ?? globalThis.fetch;

  const createError = (status: number, message: string, code = 'UNKNOWN', fields?: Record<string, string>, retryAfterSec?: number): HttpError => {
    const err = Object.create(Error.prototype);
    err.name = 'HttpError';
    err.message = message;
    err.status = status;
    err.code = code;
    if (fields) err.fields = fields;
    if (retryAfterSec !== undefined) err.retryAfterSec = retryAfterSec;
    Object.setPrototypeOf(err, Error.prototype);
    return err;
  };

  const performRequest = async (path: string, method: string, body?: unknown, asText = false, extraHeaders?: Record<string, string>): Promise<unknown> => {
    const token = await opts.getToken?.();
    const url = new URL(path, opts.baseUrl).toString();

    // A Blob goes out as is, under its own type (dictation audio); everything else is JSON.
    const raw = typeof Blob !== 'undefined' && body instanceof Blob;
    const headers: Record<string, string> = { 'Content-Type': raw ? body.type : 'application/json', ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;

    const init: RequestInit = { method, headers };
    if (raw) init.body = body;
    else if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch_(url, init);

    if (!res.ok) {
      let errorMsg = `HTTP ${res.status}`;
      let errorCode = 'HTTP_ERROR';
      let errorFields: Record<string, string> | undefined;
      let retryAfterSec: number | undefined;
      try {
        const data = await res.json();
        if (data && typeof data === 'object' && 'error' in data) {
          const error = data.error;
          if (error && typeof error === 'object') {
            if ('message' in error && typeof error.message === 'string') errorMsg = error.message;
            if ('code' in error && typeof error.code === 'string') errorCode = error.code;
            if ('retryAfterSec' in error && typeof error.retryAfterSec === 'number') retryAfterSec = error.retryAfterSec;
            if ('fields' in error) {
              const parsed = z.record(z.string(), z.string()).safeParse(error.fields);
              if (parsed.success) errorFields = parsed.data;
            }
          }
        }
      } catch {
        // ignore parse error
      }
      throw createError(res.status, errorMsg, errorCode, errorFields, retryAfterSec);
    }

    // Best-effort presence endpoints (typing) answer 204 with no body.
    if (res.status === 204) return undefined;
    if (asText) return res.text();

    return softenUiDocs(await res.json());
  };

  async function request<T>(
    path: string,
    method: string,
    body: unknown,
    schema: ZodSchema<T>,
    headers?: Record<string, string>,
  ): Promise<T>;
  async function request(
    path: string,
    method: string,
    body?: unknown,
  ): Promise<unknown>;
  async function request<T>(
    path: string,
    method: string,
    body?: unknown,
    schema?: ZodSchema<T>,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const data = await performRequest(path, method, body, false, headers);
    if (schema) return schema.parse(data);
    return data;
  }

  const parse = <T>(schema: ZodSchema<T>, data: unknown): T => schema.parse(data);

  /** True when the item failed only because a field holds a value this version does not know (zod's `invalid_value`: an enum or literal). */
  const onlyUnknownValues = (error: unknown): boolean =>
    error instanceof z.ZodError && error.issues.length > 0 && error.issues.every((issue) => issue.code === 'invalid_value');

  const list = async <T>(path: string, schema: ZodSchema<T>): Promise<ListResult<T>> => {
    const listResponseSchema = z.object({
      items: z.array(z.unknown()),
      nextCursor: z.string().nullable().optional(),
    });
    const data = await request(path, 'GET', undefined, listResponseSchema);
    const items: T[] = [];
    for (const item of data.items) {
      const parsed = schema.safeParse(item);
      if (parsed.success) items.push(parsed.data);
      else if (!onlyUnknownValues(parsed.error)) throw parsed.error;
    }
    return { items, nextCursor: data.nextCursor === undefined ? null : data.nextCursor };
  };

  const text = async (path: string): Promise<string> => {
    const body = await performRequest(path, 'GET', undefined, true);
    if (typeof body !== 'string') throw createError(502, 'Expected a text response');
    return body;
  };

  return { baseUrl: opts.baseUrl, request, list, text, parse };
}

