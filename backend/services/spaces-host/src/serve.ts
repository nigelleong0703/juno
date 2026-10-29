/**
 * The request handling of the hosted Spaces Worker (BACKEND 5.12, option B). One Worker serves every publication: the host
 * label names the publication (`<slug>-<linkId>.<CONTENT_DOMAIN>`), the publication row says whether it is live and who may
 * open it, the files come from R2 (`<linkId>/<version>/<path>`), and `/api/<table>` is the Space's data API over D1.
 *
 * Access: `link` and `public` need no login (anyone with the URL) and visitors may read the data. `private` needs the owner's
 * session cookie, set when the owner opens the signed link on `/__auth`, or an owner token as a Bearer; otherwise 403.
 * Visitors may change the data only when the publication allows it (`visitor_writes`); the owner always may. A revoked or
 * unknown link is 404.
 * Every response is on this content domain only: the app's cookies and origin never reach it, and nothing from the app is
 * forwarded.
 */
import { MAX_ROWS_PER_PUBLICATION, MAX_ROW_BYTES, isSafePath, linkIdOfLabel, objectKey, type Visibility, isVisibility } from './names.js';
import { signLinkToken, verifyLinkToken } from './tokens.js';

export interface HostedEnv {
  DB: D1Database;
  FILES: R2Bucket;
  /** Published Spaces live under this domain; the app's own domain must never be it. */
  CONTENT_DOMAIN: string;
  /** HMAC key of the owner links (a Worker secret). */
  SPACES_HOST_SIGNING_KEY: string;
}

const SESSION_COOKIE = 'space_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const LIST_LIMIT = 500;
const TABLE_ROUTE = /^\/api\/([a-z][a-z0-9_]{0,62})(?:\/([A-Za-z0-9_-]{1,64}))?$/;

/** What a page may load: its own origin only, no frames of ours (clickjacking), no plugins, no base or form targets elsewhere. */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

interface Publication {
  id: string;
  host: string;
  visibility: Visibility;
  /** 1 when visitors may change the data (the owner always may). */
  visitor_writes: number;
  version: number;
  revoked_at: string | null;
}

export async function handleRequest(request: Request, env: HostedEnv, now = Date.now()): Promise<Response> {
  const host = (request.headers.get('host') ?? '').toLowerCase().replace(/:\d+$/, '');
  const suffix = '.' + env.CONTENT_DOMAIN.toLowerCase();
  if (!host.endsWith(suffix)) return plain(404, 'not found');
  const label = host.slice(0, -suffix.length);
  if (linkIdOfLabel(label) === undefined) return plain(404, 'not found');

  const row = await env.DB.prepare('SELECT id, host, visibility, visitor_writes, version, revoked_at FROM publications WHERE host = ?')
    .bind(label)
    .first<Publication>();
  if (row === null || row.revoked_at !== null || !isVisibility(row.visibility)) return plain(404, 'not found');
  const url = new URL(request.url);

  if (url.pathname === '/__auth') return openOwnerLink(request, env, row, url, now);
  const owner = await isOwner(request, env, row.id, now);
  if (row.visibility === 'private' && !owner) return plain(403, 'This Space is private. Open it from Juno.');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const changes = request.method !== 'GET' && request.method !== 'HEAD';
    if (changes && !owner && row.visitor_writes !== 1) return json(403, { error: { code: 'READ_ONLY', message: 'Visitors can read this Space, not change it' } });
    return tableApi(request, env, row, url);
  }
  return staticFile(request, env, row, url);
}

/** The owner's signed link: sets the session cookie (host-only, HttpOnly, Secure) and goes to the app's start page. */
async function openOwnerLink(request: Request, env: HostedEnv, row: Publication, url: URL, now: number): Promise<Response> {
  if (request.method !== 'GET') return plain(405, 'method not allowed');
  const claims = await verifyLinkToken(url.searchParams.get('t') ?? '', env.SPACES_HOST_SIGNING_KEY, 'owner', row.id, now);
  if (claims === null) return plain(403, 'This link has expired. Open the Space again from Juno.');
  const session = await signLinkToken({ kind: 'session', pub: row.id, exp: now + SESSION_MS }, env.SPACES_HOST_SIGNING_KEY);
  return new Response(null, {
    status: 302,
    headers: {
      location: '/',
      'set-cookie': `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${String(SESSION_MS / 1000)}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function isOwner(request: Request, env: HostedEnv, pub: string, now: number): Promise<boolean> {
  const key = env.SPACES_HOST_SIGNING_KEY;
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.startsWith('Bearer ') && (await verifyLinkToken(authorization.slice(7), key, 'owner', pub, now)) !== null) return true;
  const session = cookieValue(request.headers.get('cookie'), SESSION_COOKIE);
  return session !== undefined && (await verifyLinkToken(session, key, 'session', pub, now)) !== null;
}

function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

interface StoredRow {
  row_id: string;
  body: string;
}

/** The Space's data API: `GET/POST /api/<table>`, `GET/PATCH/DELETE /api/<table>/<id>`. Rows are `{id, ...fields}` as the client sees them. */
async function tableApi(request: Request, env: HostedEnv, pub: Publication, url: URL): Promise<Response> {
  const match = TABLE_ROUTE.exec(url.pathname);
  if (match === null) return json(404, { error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
  const table = match[1] ?? '';
  const rowId = match[2];
  const method = request.method;
  if (method === 'GET' && rowId === undefined) return listRows(env, pub.id, table);
  if (method === 'GET' && rowId !== undefined) {
    const row = await findRow(env, pub.id, table, rowId);
    return row === null ? json(404, { error: { code: 'NOT_FOUND', message: 'no such row' } }) : json(200, row);
  }
  if (method === 'POST' && rowId === undefined) return createRow(request, env, pub.id, table);
  if ((method === 'PATCH' || method === 'DELETE') && rowId !== undefined) return changeRow(request, env, pub.id, table, rowId, method);
  return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed here' } });
}

async function listRows(env: HostedEnv, pub: string, table: string): Promise<Response> {
  const answer = await env.DB.prepare(
    'SELECT row_id, body FROM space_rows WHERE publication_id = ? AND table_name = ? ORDER BY CAST(row_id AS INTEGER) DESC, row_id DESC LIMIT ?',
  )
    .bind(pub, table, LIST_LIMIT)
    .all<StoredRow>();
  return json(200, answer.results.map(toRow));
}

async function findRow(env: HostedEnv, pub: string, table: string, rowId: string): Promise<Record<string, unknown> | null> {
  const stored = await env.DB.prepare('SELECT row_id, body FROM space_rows WHERE publication_id = ? AND table_name = ? AND row_id = ?')
    .bind(pub, table, rowId)
    .first<StoredRow>();
  return stored === null ? null : toRow(stored);
}

async function createRow(request: Request, env: HostedEnv, pub: string, table: string): Promise<Response> {
  const body = await readFields(request);
  if (body instanceof Response) return body;
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM space_rows WHERE publication_id = ?').bind(pub).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_ROWS_PER_PUBLICATION) return json(413, { error: { code: 'FULL', message: 'this Space holds its maximum number of rows' } });
  const next = await env.DB.prepare('SELECT COALESCE(MAX(CAST(row_id AS INTEGER)), 0) + 1 AS next FROM space_rows WHERE publication_id = ? AND table_name = ?')
    .bind(pub, table)
    .first<{ next: number }>();
  const id = String(next?.next ?? 1);
  try {
    await env.DB.prepare('INSERT INTO space_rows (publication_id, table_name, row_id, body) VALUES (?, ?, ?, ?)').bind(pub, table, id, JSON.stringify(body)).run();
  } catch {
    return json(409, { error: { code: 'CONFLICT', message: 'another write took this id; try again' } });
  }
  return json(201, { id: Number(id), ...body });
}

async function changeRow(request: Request, env: HostedEnv, pub: string, table: string, rowId: string, method: 'PATCH' | 'DELETE'): Promise<Response> {
  if (method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM space_rows WHERE publication_id = ? AND table_name = ? AND row_id = ?').bind(pub, table, rowId).run();
    return result.meta.changes > 0 ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }) : json(404, { error: { code: 'NOT_FOUND', message: 'no such row' } });
  }
  const fields = await readFields(request);
  if (fields instanceof Response) return fields;
  const existing = await findRow(env, pub, table, rowId);
  if (existing === null) return json(404, { error: { code: 'NOT_FOUND', message: 'no such row' } });
  const { id: _id, ...current } = existing;
  const merged = { ...current, ...fields };
  await env.DB.prepare('UPDATE space_rows SET body = ? WHERE publication_id = ? AND table_name = ? AND row_id = ?').bind(JSON.stringify(merged), pub, table, rowId).run();
  return json(200, { id: existing['id'], ...merged });
}

/** The JSON object of a request body without its `id` (the id is the server's), or the 4xx answer. */
async function readFields(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_ROW_BYTES) return json(413, { error: { code: 'TOO_LARGE', message: 'the row is too large' } });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return json(400, { error: { code: 'INVALID_BODY', message: 'the body must be JSON' } });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return json(400, { error: { code: 'INVALID_BODY', message: 'the body must be a JSON object' } });
  const fields: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) if (key !== 'id') fields[key] = field;
  return fields;
}

function toRow(stored: StoredRow): Record<string, unknown> {
  const body = JSON.parse(stored.body) as Record<string, unknown>;
  return { id: /^\d+$/.test(stored.row_id) ? Number(stored.row_id) : stored.row_id, ...body };
}

async function staticFile(request: Request, env: HostedEnv, pub: Publication, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'method not allowed');
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return plain(404, 'not found');
  }
  let rel = decoded.slice(1);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  if (!isSafePath(rel)) return plain(404, 'not found');
  let object = await env.FILES.get(objectKey(pub.id, pub.version, rel));
  // A path without an extension is a client-side route: the app's start page answers it.
  if (object === null && !rel.includes('.')) {
    rel = 'index.html';
    object = await env.FILES.get(objectKey(pub.id, pub.version, rel));
  }
  if (object === null) return plain(404, 'not found');
  const headers = new Headers({
    'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'content-security-policy': PAGE_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': pub.visibility === 'private' ? 'private, no-store' : 'no-cache',
    vary: 'cookie',
  });
  // `link` is shared, not published: keep search engines out. `public` is meant to be found.
  if (pub.visibility !== 'public') headers.set('x-robots-tag', 'noindex, nofollow');
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

function plain(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
