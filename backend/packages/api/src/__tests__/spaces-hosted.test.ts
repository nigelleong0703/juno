/**
 * The hosted Spaces routes (BACKEND 5.12, option B) on a memory store, with a fake publisher and a fake computer. The real
 * publisher and Worker are tested in services/spaces-host; this pins the API's side: the rows, the owner scope, the answers.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import type { SpaceRecord } from '@agent-desktop/contracts';
import { HostedError, type Access, type HostedSpacesPublisher, type PublishInput } from '@agent-desktop/spaces-host/publisher';
import { hostableSnapshot, spaceSnapshotSchema, type HostedRow, type SnapshotFile } from '@agent-desktop/spaces-host/snapshot';
import { setRequestOwner } from '../owner.js';
import { registerSpaces, type SpaceRoutesDeps } from '../routes/spaces.js';
import { revokeOwnerHosted, type HostedDeps, type HostedSetup } from '../modules/spaces-hosted.js';

const OWNER = 'owner-a';
const OTHER = 'owner-b';
const SPACE = 'sp' + '1'.repeat(24);
const NOW = '2026-10-26T10:00:00.000Z';

interface Fake {
  publisher: HostedSpacesPublisher;
  publishes: PublishInput[];
  /** The next publish throws this (then the fake behaves again). */
  failNext: { error: Error | null };
}

interface Link {
  visibility: 'private' | 'link' | 'public';
  visitorWrites: boolean;
  version: number;
  revoked: boolean;
}

/** A publisher that keeps its links in memory and follows the real publisher's rules: new link, version, access, revoke. */
function fakePublisher(): Fake {
  const links = new Map<string, Link>();
  const publishes: PublishInput[] = [];
  const failNext: { error: Error | null } = { error: null };
  let counter = 0;
  const live = (linkId: string): Link => {
    const link = links.get(linkId);
    if (link === undefined || link.revoked) throw new HostedError('not_found', 'this Space has no live hosted link');
    return link;
  };
  const publisher: HostedSpacesPublisher = {
    async publish(input) {
      publishes.push(input);
      if (failNext.error !== null) {
        const error = failNext.error;
        failNext.error = null;
        throw error;
      }
      if (input.linkId === undefined) {
        counter += 1;
        const linkId = counter.toString(16).padStart(20, '0');
        const link: Link = { visibility: input.visibility ?? 'link', visitorWrites: input.visitorWrites ?? false, version: 1, revoked: false };
        links.set(linkId, link);
        return { linkId, url: `https://${input.slug}-${linkId}.spaces.example.com/`, version: 1, visibility: link.visibility, visitorWrites: link.visitorWrites };
      }
      const link = live(input.linkId);
      link.version += 1;
      if (input.visibility !== undefined) link.visibility = input.visibility;
      if (input.visitorWrites !== undefined) link.visitorWrites = input.visitorWrites;
      return { linkId: input.linkId, url: `https://${input.slug}-${input.linkId}.spaces.example.com/`, version: link.version, visibility: link.visibility, visitorWrites: link.visitorWrites };
    },
    async setAccess(linkId, access: Access) {
      const link = live(linkId);
      if (access.visibility !== undefined) link.visibility = access.visibility;
      if (access.visitorWrites !== undefined) link.visitorWrites = access.visitorWrites;
      return { visibility: link.visibility, visitorWrites: link.visitorWrites };
    },
    async revoke(linkId) {
      const link = links.get(linkId);
      if (link === undefined) throw new HostedError('not_found', 'this Space has no hosted link');
      link.revoked = true;
    },
    async ownerOpenUrl(linkId, expiresAt) {
      live(linkId);
      return `https://notes-${linkId}.spaces.example.com/__auth?t=token-${String(expiresAt)}`;
    },
  };
  return { publisher, publishes, failNext };
}

/**
 * The hosting deps over a fake publisher. The computer answers with a one-page app (`ok`), fails to answer (`unreadable`), or
 * answers with an app that has its own server file (`server_code`, checked by the real hostableSnapshot).
 */
function hostingWith(fake: Fake, mode: 'ok' | 'unreadable' | 'server_code' = 'ok'): HostedSetup {
  const deps: HostedDeps = {
    publisher: fake.publisher,
    snapshot: async (_owner, slug) => {
      if (mode === 'unreadable') throw new Error('computerd /v1/spaces/snapshot answered 500');
      const files: SnapshotFile[] = [{ path: 'index.html', bytes: new TextEncoder().encode(`<title>${slug}</title>`) }];
      const tables: Record<string, HostedRow[]> = { notes: [{ rowId: '1', body: { text: 'first', createdAt: NOW } }] };
      if (mode === 'server_code') return hostableSnapshot(spaceSnapshotSchema.parse({ root: 'dist', files: [{ path: 'index.html', base64: 'PHA+' }], tables: {}, serverCode: ['server.ts'] }));
      return { files, tables };
    },
  };
  return { ready: true, deps };
}

function appWith(hosted: HostedSetup | undefined) {
  const store = createMemoryStore();
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRequestOwner(c, c.req.header('x-owner') ?? '');
    await next();
  });
  const spaces: SpaceRoutesDeps = { domain: 'spaces.localhost:8787', scheme: 'http', secret: 'space-secret', ...(hosted === undefined ? {} : { hosted }) };
  registerSpaces(app, { store, blobs: createMemoryBlobStore(), spaces });
  return { app, store };
}

async function seedSpace(store: ReturnType<typeof createMemoryStore>, owner: string): Promise<void> {
  const row: SpaceRecord = { id: SPACE, ownerId: owner, agentId: 'agent-1', slug: 'notes', title: 'Notes', port: 7100, status: 'published', artifactId: 'lib-1', createdAt: NOW, updatedAt: NOW };
  await store.forOwner?.(owner).put('spaces', row, { agentId: 'agent-1', status: 'published', parentId: 'lib-1' });
}

async function call(app: Hono, method: string, path: string, options: { owner?: string; body?: unknown } = {}): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
  const response = await app.request(path, {
    method,
    headers: { 'x-owner': options.owner ?? OWNER, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>) };
}

describe('hosted Spaces routes', () => {
  it('answers 503 with the reason when hosting is not configured', async () => {
    const { app, store } = appWith({ ready: false, reason: 'hosted Spaces are not configured on this server: set CF_ACCOUNT_ID' });
    await seedSpace(store, OWNER);
    const answer = await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} });
    expect(answer.status).toBe(503);
    expect(answer.json).toMatchObject({ error: { code: 'HOSTED_UNAVAILABLE', message: expect.stringContaining('CF_ACCOUNT_ID') as unknown as string } });
  });

  it('publishes, shows the link on the Space, changes visibility, opens the owner link and revokes', async () => {
    const fake = fakePublisher();
    const { app, store } = appWith(hostingWith(fake));
    await seedSpace(store, OWNER);

    const published = await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: { visibility: 'private' } });
    expect(published.status).toBe(200);
    expect(published.json).toMatchObject({ spaceId: SPACE, visibility: 'private', visitorWrites: false, version: 1 });
    expect(fake.publishes[0]).toMatchObject({ slug: 'notes', visibility: 'private' });
    expect(fake.publishes[0]?.linkId).toBeUndefined();
    expect(await store.forOwner?.(OWNER).get('spaceHosted', SPACE)).toMatchObject({ id: SPACE, visibility: 'private', visitorWrites: false, version: 1, agentId: 'agent-1' });

    expect((await call(app, 'GET', `/v1/spaces/${SPACE}`)).json).toMatchObject({ id: SPACE, hosted: { spaceId: SPACE, visibility: 'private', version: 1 } });
    expect((await call(app, 'GET', '/v1/spaces')).json).toMatchObject({ items: [{ id: SPACE, hosted: { version: 1 } }] });

    const url = (published.json?.['url'] ?? '') as string;
    const changed = await call(app, 'PATCH', `/v1/spaces/${SPACE}/hosted`, { body: { visibility: 'public' } });
    expect(changed.json).toMatchObject({ visibility: 'public', visitorWrites: false, url });
    expect((await call(app, 'PATCH', `/v1/spaces/${SPACE}/hosted`, { body: { visibility: 'nobody' } })).status).toBe(400);

    const opened = await call(app, 'POST', `/v1/spaces/${SPACE}/hosted/open-url`);
    expect(opened.status).toBe(200);
    expect(String(opened.json?.['url'])).toContain('/__auth?t=token-');

    const republished = await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} });
    expect(republished.json).toMatchObject({ version: 2, visibility: 'public', visitorWrites: false, url });
    expect(fake.publishes[1]?.linkId).toBeDefined();

    expect((await call(app, 'DELETE', `/v1/spaces/${SPACE}/hosted`)).status).toBe(204);
    expect((await call(app, 'GET', `/v1/spaces/${SPACE}`)).json?.['hosted']).toBeUndefined();
    expect((await call(app, 'PATCH', `/v1/spaces/${SPACE}/hosted`, { body: { visibility: 'link' } })).status).toBe(404);
    expect((await call(app, 'POST', `/v1/spaces/${SPACE}/hosted/open-url`)).status).toBe(404);
    expect((await call(app, 'DELETE', `/v1/spaces/${SPACE}/hosted`)).status).toBe(404);

    // Publishing again after a revoke is a new link: the old URL stays dead.
    const again = await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} });
    expect(again.json).toMatchObject({ version: 1, visibility: 'link', visitorWrites: false });
    expect(again.json?.['url']).not.toBe(url);
    expect(fake.publishes[2]?.linkId).toBeUndefined();
  });

  it('lets visitors change the data only when the owner allows it, and the owner can always do so', async () => {
    const fake = fakePublisher();
    const { app, store } = appWith(hostingWith(fake));
    await seedSpace(store, OWNER);

    // Read-only for visitors by default.
    const published = await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} });
    expect(published.json).toMatchObject({ visitorWrites: false });

    // Switched on at publish, and changed on its own later (the visibility stays as it is).
    const allowed = await call(app, 'PATCH', `/v1/spaces/${SPACE}/hosted`, { body: { visitorWrites: true } });
    expect(allowed.json).toMatchObject({ visibility: 'link', visitorWrites: true });
    expect((await call(app, 'PATCH', `/v1/spaces/${SPACE}/hosted`, { body: {} })).status).toBe(400);
    expect((await call(app, 'PATCH', `/v1/spaces/${SPACE}/hosted`, { body: { visitorWrites: false } })).json).toMatchObject({ visitorWrites: false, visibility: 'link' });

    // A republish that names nothing keeps the access it has; one that names it changes it.
    expect((await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: { visitorWrites: true } })).json).toMatchObject({ version: 2, visitorWrites: true });
    expect((await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} })).json).toMatchObject({ version: 3, visitorWrites: true });
    expect(fake.publishes[2]?.visitorWrites).toBeUndefined();
    expect((await store.forOwner?.(OWNER).get('spaceHosted', SPACE))?.visitorWrites).toBe(true);
  });

  it('two publishes at once make one link (a double click is a republish)', async () => {
    const fake = fakePublisher();
    const { app, store } = appWith(hostingWith(fake));
    await seedSpace(store, OWNER);
    const [first, second] = await Promise.all([call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} }), call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} })]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.json?.['url']).toBe(second.json?.['url']);
    expect(fake.publishes.map((input) => input.linkId === undefined)).toEqual([true, false]);
    expect((await store.forOwner?.(OWNER).get('spaceHosted', SPACE))?.version).toBe(2);
  });

  it('keeps every Space to its owner: another owner sees and changes nothing', async () => {
    const fake = fakePublisher();
    const { app, store } = appWith(hostingWith(fake));
    await seedSpace(store, OWNER);
    expect((await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { owner: OTHER, body: {} })).status).toBe(404);
    await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} });
    expect((await call(app, 'PATCH', `/v1/spaces/${SPACE}/hosted`, { owner: OTHER, body: { visibility: 'public' } })).status).toBe(404);
    expect((await call(app, 'DELETE', `/v1/spaces/${SPACE}/hosted`, { owner: OTHER })).status).toBe(404);
    expect((await call(app, 'GET', `/v1/spaces/${SPACE}`, { owner: OTHER })).status).toBe(404);
    expect((await call(app, 'GET', '/v1/spaces', { owner: OTHER })).json).toEqual({ items: [] });
  });

  it('refuses a Space that runs its own server code, before anything is published', async () => {
    const fake = fakePublisher();
    const { app, store } = appWith(hostingWith(fake, 'server_code'));
    await seedSpace(store, OWNER);
    const refused = await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} });
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({
      error: { code: 'SPACE_HAS_SERVER_CODE', message: 'This Space runs its own server code; it can only be shared from your computer (option A)' },
    });
    expect(fake.publishes).toEqual([]);
  });

  it('says why a Space cannot be read, cannot be hosted, or cannot be stored, without the details of the service', async () => {
    const unreadable = fakePublisher();
    const broken = appWith(hostingWith(unreadable, 'unreadable'));
    await seedSpace(broken.store, OWNER);
    const notRead = await call(broken.app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} });
    expect(notRead.status).toBe(502);
    expect(notRead.json).toMatchObject({ error: { code: 'SPACE_UNREADABLE' } });

    const fake = fakePublisher();
    const { app, store } = appWith(hostingWith(fake));
    await seedSpace(store, OWNER);
    fake.failNext.error = new HostedError('invalid', 'the Space has no built index.html');
    expect((await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} })).status).toBe(422);

    fake.failNext.error = new HostedError('storage', 'Cloudflare R2 answered 500');
    const stored = await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} });
    expect(stored.status).toBe(502);
    expect(JSON.stringify(stored.json)).not.toContain('R2');
  });

  it('refuses to publish a Space that is not published', async () => {
    const fake = fakePublisher();
    const { app } = appWith(hostingWith(fake));
    expect((await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} })).status).toBe(404);
    expect(fake.publishes).toEqual([]);
  });

  it('revokes every live link before an account is deleted, and refuses while hosting is off', async () => {
    const fake = fakePublisher();
    const { app, store } = appWith(hostingWith(fake));
    await seedSpace(store, OWNER);
    await call(app, 'POST', `/v1/spaces/${SPACE}/publish-hosted`, { body: {} });
    const scoped = store.forOwner?.(OWNER);
    if (scoped === undefined) throw new Error('memory store is owner-scoped');

    expect(await revokeOwnerHosted(scoped, undefined)).toBe('hosted Spaces are not wired on this server');
    expect(await revokeOwnerHosted(scoped, { ready: false, reason: 'hosting is off' })).toBe('hosting is off');
    expect((await scoped.get('spaceHosted', SPACE))?.revokedAt).toBeUndefined();

    expect(await revokeOwnerHosted(scoped, hostingWith(fake))).toBeUndefined();
    expect((await scoped.get('spaceHosted', SPACE))?.revokedAt).toBeDefined();
    expect(await revokeOwnerHosted(scoped, undefined)).toBeUndefined();
    expect(await revokeOwnerHosted(store.forOwner?.(OTHER) ?? scoped, { ready: false, reason: 'hosting is off' })).toBeUndefined();
  });
});
