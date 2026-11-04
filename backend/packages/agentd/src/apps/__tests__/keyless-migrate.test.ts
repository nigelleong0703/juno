/**
 * The public YouTube connection made before the 2026-10-19 split kept its Google sign-in; when that sign-in died the app that needs no
 * account went to "reconnect". The migration drops the sign-in; a real sign-in app and other owners' rows are left alone.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import { connectionStanding } from 'juno-agent/modules/apps/agent-apps';
import { migrateKeylessConnections } from '../keyless-migrate.js';

const auth = { issuer: 'https://accounts.google.com', clientId: 'c', resource: 'http://127.0.0.1:8787/mcp/google/youtube', accessToken: 'enc:v1:x', refreshToken: 'enc:v1:y' };

describe('migrateKeylessConnections', () => {
  it('drops the sign-in from a keyless app and marks it connected; the account apps keep theirs; it runs once', async () => {
    const store = createMemoryStore();
    const row = (id: string, catalogId: string, extra: object) => store.put('connections', { id, kind: 'mcp', name: id, ownerId: 'o1', catalogId, enabled: true, status: 'error', connectedAt: '2026-10-19T00:22:00.000Z', auth, scopes: ['s'], ...extra } as never);
    await row('con-youtube', 'youtube', {});
    await row('con-youtube-off', 'youtube', { enabled: false });
    await row('con-account', 'youtube-account', {});
    await row('con-drive', 'google-drive', {});

    expect(await migrateKeylessConnections(store)).toEqual({ skipped: false, cleaned: 2 });
    const youtube = await store.get('connections', 'con-youtube');
    expect(youtube).toMatchObject({ status: 'connected', catalogId: 'youtube' });
    expect(Reflect.get(youtube!, 'auth')).toBeUndefined();
    expect(Reflect.get(youtube!, 'scopes')).toBeUndefined();
    expect(connectionStanding(youtube!)).toBe('connected');
    // An app the owner turned off stays off.
    expect(await store.get('connections', 'con-youtube-off')).toMatchObject({ enabled: false, status: 'error' });
    for (const id of ['con-account', 'con-drive']) expect(Reflect.get((await store.get('connections', id))!, 'auth')).toEqual(auth);

    expect(await migrateKeylessConnections(store)).toEqual({ skipped: true, cleaned: 0 });
  });
});
