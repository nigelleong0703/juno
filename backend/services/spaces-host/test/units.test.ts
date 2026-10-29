import { describe, expect, it } from 'vitest';
import { cloudflareStorage } from '../src/cloudflare-storage.js';
import { contentTypeFor, hostLabel, isSafePath, linkIdOfLabel, newLinkId, objectKey } from '../src/names.js';
import { HostedError, createHostedPublisher, type HostedStorage, type Statement } from '../src/publisher.js';
import { hostableSnapshot, spaceSnapshotSchema } from '../src/snapshot.js';
import { signLinkToken, verifyLinkToken } from '../src/tokens.js';

const KEY = 'unit-test-signing-key-0123456789';
const LINK = '0123456789abcdef0123';
const NOW = 1_800_000_000_000;

describe('link tokens', () => {
  it('verifies its own token for the right kind and publication, before it expires', async () => {
    const token = await signLinkToken({ kind: 'owner', pub: LINK, exp: NOW + 1000 }, KEY);
    expect(await verifyLinkToken(token, KEY, 'owner', LINK, NOW)).toEqual({ kind: 'owner', pub: LINK, exp: NOW + 1000 });
    expect(await verifyLinkToken(token, KEY, 'session', LINK, NOW)).toBeNull();
    expect(await verifyLinkToken(token, KEY, 'owner', newLinkId(), NOW)).toBeNull();
    expect(await verifyLinkToken(token, KEY, 'owner', LINK, NOW + 1000)).toBeNull();
  });

  it('refuses a token with another key, a changed payload or a malformed shape', async () => {
    const token = await signLinkToken({ kind: 'session', pub: LINK, exp: NOW + 1000 }, KEY);
    expect(await verifyLinkToken(token, 'another-key-0123456789abcdef', 'session', LINK, NOW)).toBeNull();
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ kind: 'session', pub: LINK, exp: NOW + 999_999 })).toString('base64url');
    expect(await verifyLinkToken(`${forged}.${mac ?? ''}`, KEY, 'session', LINK, NOW)).toBeNull();
    expect(await verifyLinkToken(`${payload ?? ''}`, KEY, 'session', LINK, NOW)).toBeNull();
    expect(await verifyLinkToken('not a token', KEY, 'session', LINK, NOW)).toBeNull();
    expect(await verifyLinkToken(token, KEY, 'session', LINK, NOW)).not.toBeNull();
  });

  it('refuses to sign with an empty key', async () => {
    await expect(signLinkToken({ kind: 'owner', pub: LINK, exp: NOW }, '')).rejects.toThrow('signing key is empty');
  });
});

describe('names and paths', () => {
  it('builds a host label of at most 62 characters and reads the link id back', () => {
    const label = hostLabel('a'.repeat(41), LINK);
    expect(label?.length).toBeLessThanOrEqual(62);
    expect(linkIdOfLabel(label ?? '')).toBe(LINK);
    expect(hostLabel('Bad_Slug', LINK)).toBeUndefined();
    expect(hostLabel('notes', 'XYZ')).toBeUndefined();
    expect(linkIdOfLabel('notes')).toBeUndefined();
  });

  it('accepts plain build paths and refuses traversal, hidden and odd names', () => {
    expect(isSafePath('index.html')).toBe(true);
    expect(isSafePath('assets/index-AbC123.js')).toBe(true);
    expect(isSafePath('../secret')).toBe(false);
    expect(isSafePath('a/../b')).toBe(false);
    expect(isSafePath('/abs')).toBe(false);
    expect(isSafePath('.env')).toBe(false);
    expect(isSafePath('a b.html')).toBe(false);
    expect(isSafePath('a%2e%2e/b')).toBe(false);
  });

  it('keys objects by link, version and path, and types files by extension', () => {
    expect(objectKey(LINK, 3, 'assets/a.js')).toBe(`${LINK}/3/assets/a.js`);
    expect(contentTypeFor('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('a.JS')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('a.exe')).toBe('application/octet-stream');
  });
});

describe('snapshot', () => {
  const encode = (text: string) => Buffer.from(text).toString('base64');

  it('refuses a Space that runs its own server code, with the owner-facing reason', () => {
    const snapshot = spaceSnapshotSchema.parse({ root: 'dist', files: [{ path: 'index.html', base64: encode('<p>') }], tables: {}, serverCode: ['server.ts'] });
    let caught: unknown;
    try {
      hostableSnapshot(snapshot);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HostedError);
    expect((caught as HostedError).code).toBe('server_code');
    expect((caught as HostedError).message).toBe('This Space runs its own server code; it can only be shared from your computer (option A)');
  });

  it('a snapshot from before the server check counts as no server code', () => {
    const snapshot = spaceSnapshotSchema.parse({ root: 'dist', files: [{ path: 'index.html', base64: encode('<p>') }], tables: {} });
    expect(snapshot.serverCode).toEqual([]);
    expect(() => hostableSnapshot(snapshot)).not.toThrow();
  });

  it('turns the data rows into hosted rows with camelCase fields and keeps their ids', () => {
    const snapshot = spaceSnapshotSchema.parse({
      root: 'dist',
      files: [{ path: 'index.html', base64: encode('<p>') }],
      tables: { notes: [{ id: 7, text: 'hi', created_at: 'then' }, { text: 'no id' }] },
    });
    const hosted = hostableSnapshot(snapshot);
    expect(hosted.tables['notes']).toEqual([
      { rowId: '7', body: { text: 'hi', createdAt: 'then' } },
      { rowId: '2', body: { text: 'no id' } },
    ]);
    expect(hosted.files.map((file) => file.path)).toEqual(['index.html']);
  });

  it('refuses a snapshot without a built index.html, with an unsafe file or table name', () => {
    expect(() => hostableSnapshot(spaceSnapshotSchema.parse({ root: 'public', files: [{ path: 'a.html', base64: encode('x') }], tables: {} }))).toThrow('no built index.html');
    expect(() => hostableSnapshot(spaceSnapshotSchema.parse({ root: 'dist', files: [{ path: 'index.html', base64: encode('x') }, { path: '../x', base64: encode('y') }], tables: {} }))).toThrow('file name not hostable');
    expect(() => hostableSnapshot(spaceSnapshotSchema.parse({ root: 'dist', files: [{ path: 'index.html', base64: encode('x') }], tables: { 'Bad-Name': [] } }))).toThrow('table name not hostable');
  });
});

/** A storage that records what the publisher asked for; query answers come from `rows`. */
function recording(rows: Array<Record<string, unknown>> = []) {
  const calls: string[] = [];
  const statements: Statement[][] = [];
  const storage: HostedStorage = {
    async query() {
      calls.push('query');
      return rows;
    },
    async execute(batch) {
      calls.push('execute');
      statements.push(batch);
    },
    async putObject(key) {
      calls.push('put:' + key);
    },
    async deletePrefix(prefix) {
      calls.push('delete:' + prefix);
    },
  };
  return { storage, calls, statements };
}

const publisherOver = (storage: HostedStorage) => createHostedPublisher({ storage, signingKey: KEY, contentScheme: 'https', contentDomain: 'spaces.example.com', now: () => NOW });
const page = { path: 'index.html', bytes: new Uint8Array([60, 112, 62]) };

describe('publisher', () => {
  it('refuses bad input before it touches the storage', async () => {
    const { storage, calls } = recording();
    const publisher = publisherOver(storage);
    await expect(publisher.publish({ slug: 'Bad Slug', files: [page], tables: {} })).rejects.toMatchObject({ code: 'invalid' });
    await expect(publisher.publish({ slug: 'notes', files: [{ path: 'a.html', bytes: page.bytes }], tables: {} })).rejects.toMatchObject({ code: 'invalid' });
    await expect(publisher.publish({ slug: 'notes', files: [page], tables: { 'Bad-Table': [] } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(publisher.publish({ slug: 'notes', files: [{ path: '../x', bytes: page.bytes }, page], tables: {} })).rejects.toMatchObject({ code: 'invalid' });
    expect(calls).toEqual([]);
  });

  it('writes the pages before the rows that name them, and answers the https address', async () => {
    const { storage, calls, statements } = recording();
    const result = await publisherOver(storage).publish({ slug: 'notes', files: [page], tables: { notes: [{ rowId: '1', body: { text: 'a' } }] } });
    expect(calls[0]).toMatch(/^put:[0-9a-f]{20}\/1\/index\.html$/);
    expect(calls[1]).toBe('execute');
    expect(statements[0]?.[0]?.sql).toContain('INSERT INTO publications');
    expect(statements[0]?.[0]?.params.slice(0, 5)).toEqual([result.linkId, `notes-${result.linkId}`, 'link', 0, 1]);
    expect(statements[0]?.[2]?.sql).toContain('INSERT INTO space_rows');
    expect(statements[0]?.[2]?.params).toEqual([result.linkId, 'notes', '1', '{"text":"a"}']);
    expect(result).toMatchObject({ version: 1, visibility: 'link', url: `https://notes-${result.linkId}.spaces.example.com/` });
  });

  it('answers not_found for a revoked or unknown publication, and a link is never reused', async () => {
    const revoked = recording([{ host: 'notes-' + LINK, visibility: 'link', version: 2, revoked_at: NOW }]);
    await expect(publisherOver(revoked.storage).publish({ linkId: LINK, slug: 'notes', files: [page], tables: {} })).rejects.toBeInstanceOf(HostedError);
    await expect(publisherOver(revoked.storage).setAccess(LINK, { visibility: 'public' })).rejects.toMatchObject({ code: 'not_found' });
    const none = recording([]);
    await expect(publisherOver(none.storage).revoke(LINK)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('revoke marks the link dead, drops its rows, then deletes the pages of every version', async () => {
    const { storage, calls, statements } = recording([{ host: 'notes-' + LINK, visibility: 'link', version: 2, revoked_at: null }]);
    await publisherOver(storage).revoke(LINK);
    expect(statements[0]?.[0]?.sql).toContain('SET revoked_at');
    expect(statements[0]?.[1]?.sql).toContain('DELETE FROM space_rows');
    expect(calls.slice(-1)).toEqual([`delete:${LINK}/`]);
  });

  it('a new version keeps the access of the link unless the owner changes it', async () => {
    const { storage, statements } = recording([{ host: 'notes-' + LINK, visibility: 'public', visitor_writes: 1, version: 2, revoked_at: null }]);
    const result = await publisherOver(storage).publish({ linkId: LINK, slug: 'notes', files: [page], tables: {} });
    expect(statements[0]?.[0]?.params).toEqual(['public', 1, 3, new Date(NOW).toISOString(), LINK]);
    expect(result).toMatchObject({ version: 3, visibility: 'public', visitorWrites: true });
  });

  it('access changes keep what is not named', async () => {
    const { storage, statements } = recording([{ host: 'notes-' + LINK, visibility: 'link', visitor_writes: 0, version: 1, revoked_at: null }]);
    expect(await publisherOver(storage).setAccess(LINK, { visitorWrites: true })).toEqual({ visibility: 'link', visitorWrites: true });
    expect(statements[0]?.[0]?.params.slice(0, 2)).toEqual(['link', 1]);
  });

  it('does nothing when revoking a revoked link', async () => {
    const { storage, calls, statements } = recording([{ host: 'notes-' + LINK, visibility: 'link', version: 2, revoked_at: NOW }]);
    await publisherOver(storage).revoke(LINK);
    expect(statements).toEqual([]);
    expect(calls).toEqual(['query']);
  });
});

describe('cloudflare storage', () => {
  it('sends D1 queries and R2 objects with the token, and never echoes the token in an error', async () => {
    const seen: Array<{ url: string; method: string; auth: string | null; body: unknown }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), method: init?.method ?? 'GET', auth: headers.get('authorization'), body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
      if (String(url).includes('/d1/')) return Response.json({ success: true, result: [{ results: [{ n: 1 }], success: true }] });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const storage = cloudflareStorage({ accountId: 'acct', apiToken: 'secret-token', databaseId: 'db', bucket: 'files', fetch: fake });
    expect(await storage.query('SELECT 1 AS n', [])).toEqual([{ n: 1 }]);
    await storage.putObject(`${LINK}/1/a b.js`, new Uint8Array([1]), 'text/javascript');
    expect(seen[0]).toMatchObject({ url: 'https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query', method: 'POST', auth: 'Bearer secret-token', body: { sql: 'SELECT 1 AS n', params: [] } });
    expect(seen[1]?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/files/objects/${encodeURIComponent(`${LINK}/1/a b.js`)}`);

    const refusing = cloudflareStorage({ accountId: 'acct', apiToken: 'secret-token', databaseId: 'db', bucket: 'files', fetch: (async () => Response.json({ success: false, errors: [{ message: 'nope' }] }, { status: 403 })) as typeof fetch });
    const failure = await refusing.query('SELECT 1', []).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostedError);
    expect(String((failure as Error).message)).toBe('Cloudflare D1 answered 403');
    expect(String((failure as Error).message)).not.toContain('secret-token');
  });
});
