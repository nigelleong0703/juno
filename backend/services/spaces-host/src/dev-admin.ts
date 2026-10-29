/**
 * Development only (the entry of wrangler.dev.toml, never deployed): the storage operations of the publisher over HTTP, so a local
 * `wrangler dev` (or the test's) can be published to by devStorage (local-storage.ts). Every request needs the admin token; without one set
 * in the environment the endpoints answer 404.
 */
import type { SqlValue } from './publisher.js';

export interface DevEnv {
  DB: D1Database;
  FILES: R2Bucket;
  /** The admin token of the local storage; empty = no admin endpoints. */
  ADMIN_TOKEN?: string;
}

interface Statement {
  sql: string;
  params: SqlValue[];
}

const ADMIN = '/__admin/';

export function isAdminPath(pathname: string): boolean {
  return pathname.startsWith(ADMIN);
}

export async function handleAdmin(request: Request, env: DevEnv): Promise<Response> {
  const token = env.ADMIN_TOKEN ?? '';
  if (token === '' || request.headers.get('authorization') !== `Bearer ${token}`) return new Response('not found', { status: 404 });
  const { pathname } = new URL(request.url);
  try {
    if (request.method === 'POST' && pathname === ADMIN + 'd1/query') {
      const statement = parseStatement(await request.json());
      const answer = await env.DB.prepare(statement.sql)
        .bind(...statement.params)
        .all();
      return Response.json({ results: answer.results });
    }
    if (request.method === 'POST' && pathname === ADMIN + 'd1/batch') {
      const body: unknown = await request.json();
      if (typeof body !== 'object' || body === null || !('statements' in body) || !Array.isArray(body.statements)) return new Response('bad batch', { status: 400 });
      const statements = body.statements.map(parseStatement);
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement.sql).bind(...statement.params)));
      return Response.json({ ok: true });
    }
    if (request.method === 'POST' && pathname === ADMIN + 'r2/delete-prefix') {
      const body: unknown = await request.json();
      if (typeof body !== 'object' || body === null || !('prefix' in body) || typeof body.prefix !== 'string') return new Response('bad prefix', { status: 400 });
      let cursor: string | undefined;
      do {
        const listing: R2Objects = await env.FILES.list({ prefix: body.prefix, ...(cursor === undefined ? {} : { cursor }) });
        for (const object of listing.objects) await env.FILES.delete(object.key);
        cursor = listing.truncated ? listing.cursor : undefined;
      } while (cursor !== undefined);
      return Response.json({ ok: true });
    }
    if (request.method === 'PUT' && pathname.startsWith(ADMIN + 'r2/')) {
      const key = decodeURIComponent(pathname.slice((ADMIN + 'r2/').length));
      await env.FILES.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: request.headers.get('content-type') ?? 'application/octet-stream' } });
      return Response.json({ ok: true });
    }
  } catch {
    return new Response('admin operation failed', { status: 500 });
  }
  return new Response('not found', { status: 404 });
}

function parseStatement(value: unknown): Statement {
  if (typeof value !== 'object' || value === null || !('sql' in value) || typeof value.sql !== 'string') throw new Error('a statement needs sql');
  const params: SqlValue[] = [];
  if ('params' in value && Array.isArray(value.params)) {
    for (const param of value.params) {
      if (param === null || typeof param === 'string' || typeof param === 'number') params.push(param);
      else throw new Error('a parameter must be a string, a number or null');
    }
  }
  return { sql: value.sql, params };
}
