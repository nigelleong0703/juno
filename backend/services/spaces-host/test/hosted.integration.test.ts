/**
 * The hosted Spaces Worker end to end, locally: `wrangler dev`'s runtime (workerd, in memory) runs the development entry on a
 * free port, the publisher writes to it through the local storage, and plain HTTP requests carry the publication's Host header.
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unstable_startWorker as startWorker } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostedPublisher, type HostedSpacesPublisher } from '../src/publisher.js';
import { devStorage } from '../src/local-storage.js';
import type { HostedRow, SnapshotFile } from '../src/snapshot.js';

type DevWorker = Awaited<ReturnType<typeof startWorker>>;

const CONTENT_DOMAIN = 'content.test';
const ADMIN_TOKEN = 'test-admin-token-0123456789';
const SIGNING_KEY = 'test-signing-key-0123456789abcdef';
const JSON_HEADERS = { 'content-type': 'application/json' };
const CREATED = '2026-10-26T10:00:00.000Z';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(port: number, host: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: { host, ...options.headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

const page = (text: string): SnapshotFile => ({ path: 'index.html', bytes: new TextEncoder().encode(`<!doctype html><title>${text}</title><script src="/assets/app.js"></script>`) });
const script: SnapshotFile = { path: 'assets/app.js', bytes: new TextEncoder().encode('console.log("notes");') };
const notes = (...texts: string[]): Record<string, HostedRow[]> => ({
  notes: texts.map((text, index) => ({ rowId: String(index + 1), body: { text, createdAt: CREATED } })),
});

/** The link id inside a host of the form `<slug>-<linkId>.<domain>`. */
function linkIdOf(host: string): string {
  const label = host.slice(0, host.indexOf('.'));
  return label.slice(label.length - 20);
}

/** The migration's statements (its comments removed), in order. */
function migrationStatements(): string[] {
  const sql = readFileSync(fileURLToPath(new URL('../migrations/0001_init.sql', import.meta.url)), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

describe('hosted Spaces: the Worker under wrangler dev', () => {
  let worker: DevWorker;
  let port: number;
  let publisher: HostedSpacesPublisher;

  beforeAll(async () => {
    port = await freePort();
    worker = await startWorker({
      config: fileURLToPath(new URL('./wrangler.test.toml', import.meta.url)),
      dev: { server: { port }, inspector: false, liveReload: false, watch: false, logLevel: 'error', persist: false },
    });
    await worker.ready;
    const storage = devStorage({ baseUrl: `http://127.0.0.1:${port}`, adminToken: ADMIN_TOKEN });
    await storage.execute(migrationStatements().map((sql) => ({ sql, params: [] })));
    publisher = createHostedPublisher({ storage, signingKey: SIGNING_KEY, contentScheme: 'http', contentDomain: CONTENT_DOMAIN });
  }, 120_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  /** The owner's session cookie for a publication, from its signed owner link (the way the owner opens it). */
  async function ownerCookie(host: string, linkId: string): Promise<string> {
    const url = new URL(await publisher.ownerOpenUrl(linkId, Date.now() + 5 * 60_000));
    const opened = await send(port, host, url.pathname + url.search);
    expect(opened.status).toBe(302);
    expect(opened.headers['location']).toBe('/');
    const setCookie = String(opened.headers['set-cookie'] ?? '');
    expect(setCookie).toMatch(/^space_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/);
    return setCookie.split(';')[0] ?? '';
  }

  it('publishes a Space, serves it by its share link, and lets visitors read but not change it unless allowed', async () => {
    // Publish: the pages and the rows of a sample notes app. Visitors may read, not write, by default.
    const first = await publisher.publish({ slug: 'notes', files: [page('Notes'), script], tables: notes('first', 'second') });
    expect(first).toMatchObject({ version: 1, visibility: 'link', visitorWrites: false });
    const host = new URL(first.url).host;
    expect(host).toMatch(new RegExp(`^notes-[0-9a-f]{20}\\.${CONTENT_DOMAIN.replace('.', '\\.')}$`));
    const linkId = linkIdOf(host);
    const json = { headers: JSON_HEADERS };

    // Visitors read the page, its script, a client route and the data API in the client's shape.
    const start = await send(port, host, '/');
    expect(start.status).toBe(200);
    expect(start.body).toContain('<title>Notes</title>');
    expect(start.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(start.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect((await send(port, host, '/assets/app.js')).headers['content-type']).toContain('text/javascript');
    expect((await send(port, host, '/some/client/route')).body).toContain('<title>Notes</title>');
    const list = await send(port, host, '/api/notes');
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body)).toEqual([
      { id: 2, text: 'second', createdAt: CREATED },
      { id: 1, text: 'first', createdAt: CREATED },
    ]);

    // Visitors cannot change the data by default.
    expect((await send(port, host, '/api/notes', { method: 'POST', ...json, body: JSON.stringify({ text: 'visitor' }) })).status).toBe(403);
    expect((await send(port, host, '/api/notes/1', { method: 'PATCH', ...json, body: JSON.stringify({ text: 'x' }) })).status).toBe(403);
    expect((await send(port, host, '/api/notes/1', { method: 'DELETE' })).status).toBe(403);
    expect(JSON.parse((await send(port, host, '/api/notes')).body)).toHaveLength(2);

    // The owner's session can always change the data.
    const cookie = await ownerCookie(host, linkId);
    const created = await send(port, host, '/api/notes', { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ text: 'third' }) });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ id: 3, text: 'third' });
    const patched = await send(port, host, '/api/notes/3', { method: 'PATCH', headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ text: 'third!' }) });
    expect(JSON.parse(patched.body)).toMatchObject({ id: 3, text: 'third!' });
    expect((await send(port, host, '/api/notes/3', { method: 'DELETE', headers: { cookie } })).status).toBe(204);
    expect((await send(port, host, '/api/notes/3', { headers: { cookie } })).status).toBe(404);
    expect((await send(port, host, '/api/notes', { method: 'POST', headers: { ...JSON_HEADERS, cookie }, body: 'not json' })).status).toBe(400);

    // Visitors may change the data once the owner allows it, and stop again when the owner takes it back.
    expect(await publisher.setAccess(linkId, { visitorWrites: true })).toEqual({ visibility: 'link', visitorWrites: true });
    const visitorCreated = await send(port, host, '/api/notes', { method: 'POST', ...json, body: JSON.stringify({ text: 'visitor' }) });
    expect(visitorCreated.status).toBe(201);
    expect(JSON.parse(visitorCreated.body)).toMatchObject({ id: 3, text: 'visitor' });
    expect((await send(port, host, '/api/notes/3', { method: 'PATCH', ...json, body: JSON.stringify({ text: 'edited' }) })).status).toBe(200);
    expect((await send(port, host, '/api/notes/3', { method: 'DELETE' })).status).toBe(204);
    expect(await publisher.setAccess(linkId, { visitorWrites: false })).toEqual({ visibility: 'link', visitorWrites: false });
    expect((await send(port, host, '/api/notes', { method: 'POST', ...json, body: JSON.stringify({ text: 'again' }) })).status).toBe(403);

    // Private: no token, no page and no data, whatever the write setting.
    expect(await publisher.setAccess(linkId, { visibility: 'private', visitorWrites: true })).toEqual({ visibility: 'private', visitorWrites: true });
    expect((await send(port, host, '/')).status).toBe(403);
    expect((await send(port, host, '/api/notes')).status).toBe(403);
    expect((await send(port, host, '/api/notes', { method: 'POST', ...json, body: JSON.stringify({ text: 'x' }) })).status).toBe(403);
    expect((await send(port, host, '/__auth?t=forged.token')).status).toBe(403);
    expect((await send(port, host, '/', { headers: { cookie: 'space_session=forged' } })).status).toBe(403);
    expect((await send(port, host, '/', { headers: { cookie } })).status).toBe(200);
    expect((await send(port, host, '/api/notes', { headers: { cookie: 'other=1; ' + cookie } })).status).toBe(200);
    expect(await publisher.setAccess(linkId, { visibility: 'link', visitorWrites: false })).toEqual({ visibility: 'link', visitorWrites: false });

    // Republish: the same URL, a new version, the rows replaced, the access kept.
    const second = await publisher.publish({ linkId, slug: 'notes', files: [page('Notes v2'), script], tables: notes('only') });
    expect(second).toMatchObject({ version: 2, visibility: 'link', visitorWrites: false, url: first.url });
    expect((await send(port, host, '/')).body).toContain('Notes v2');
    expect(JSON.parse((await send(port, host, '/api/notes')).body)).toEqual([{ id: 1, text: 'only', createdAt: CREATED }]);

    // Public: no login to read, search engines may index it, and visitors may write when allowed.
    await publisher.setAccess(linkId, { visibility: 'public', visitorWrites: true });
    const open = await send(port, host, '/');
    expect(open.status).toBe(200);
    expect(open.headers['x-robots-tag']).toBeUndefined();
    expect(open.headers['cache-control']).toBe('no-cache');
    expect((await send(port, host, '/api/notes', { method: 'POST', ...json, body: JSON.stringify({ text: 'public visitor' }) })).status).toBe(201);

    // Revoked: 404 everywhere, the data is gone, and the link cannot be used again.
    await publisher.revoke(linkId);
    expect((await send(port, host, '/')).status).toBe(404);
    expect((await send(port, host, '/api/notes')).status).toBe(404);
    expect((await send(port, host, '/', { headers: { cookie } })).status).toBe(404);
    await expect(publisher.ownerOpenUrl(linkId, Date.now() + 60_000)).rejects.toMatchObject({ code: 'not_found' });
    await expect(publisher.publish({ linkId, slug: 'notes', files: [page('x'), script], tables: {} })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('answers 404 for a host it does not know and for another domain', async () => {
    expect((await send(port, `notes-${'0'.repeat(20)}.${CONTENT_DOMAIN}`, '/')).status).toBe(404);
    expect((await send(port, 'example.org', '/')).status).toBe(404);
    expect((await send(port, `notes-${'a'.repeat(20)}.evil.test`, '/')).status).toBe(404);
  });

  it('refuses the admin endpoints without the admin token', async () => {
    expect((await send(port, CONTENT_DOMAIN, '/__admin/d1/query', { method: 'POST', body: '{"sql":"SELECT 1"}' })).status).toBe(404);
  });
});
