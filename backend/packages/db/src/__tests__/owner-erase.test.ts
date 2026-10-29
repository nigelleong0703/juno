/**
 * The bulk deletes behind account deletion (BACKEND §5.2c), with two owners: each one removes the named owner's rows and nobody
 * else's, and running it again removes nothing. Runs on an embedded Postgres (ids are unique per run, because Postgres keeps rows).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { DurableDb } from '@agent-desktop/durable';
import { createStore, type DbStore } from '../index.js';
import { blobKeysUsedByOthers, closeAuthAccount, deleteAuthUser, deleteOwnerEvents, deleteOwnerRows } from '../owner-erase.js';
import { closeScratchPostgres, scratchPostgresUrl } from './store-backends.js';

afterAll(closeScratchPostgres);

const AT = '2026-10-22T00:00:00.000Z';
const backends: Array<{ name: string; url(): Promise<string> }> = [{ name: 'postgres', url: scratchPostgresUrl }];

const uid = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;
const blobKey = () => 'blobs/' + randomBytes(32).toString('hex');
const stores: DbStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close().catch(() => undefined);
});

describe.each(backends)('account deletion SQL ($name)', (backend) => {
  async function open(): Promise<{ store: DbStore; db: DurableDb }> {
    const store = await createStore(await backend.url());
    stores.push(store);
    if (store.raw === undefined || store.forOwner === undefined) throw new Error('the store has raw SQL and owner scopes');
    return { store, db: store.raw };
  }
  const scoped = (store: DbStore, owner: string) => {
    if (store.forOwner === undefined) throw new Error('owner scope');
    return store.forOwner(owner);
  };

  it('deletes one owner\'s rows in every collection, keeps the marker and every other owner\'s rows, and is repeatable', async () => {
    const { store, db } = await open();
    const [alice, bob] = [uid('alice'), uid('bob')];
    for (const owner of [alice, bob]) {
      const rows = scoped(store, owner);
      await rows.put('goals', { id: uid('goal'), title: 'g' } as never);
      await rows.put('modelProviders', { id: uid('prov') } as never);
      await rows.put('accountDeletions', { id: owner, startedAt: AT, updatedAt: AT, agentIds: [], done: [], attempts: 0 });
    }
    expect(await deleteOwnerRows(db, alice)).toEqual({ goals: 1, model_providers: 1 });
    expect((await scoped(store, alice).list('goals')).items).toHaveLength(0);
    expect((await scoped(store, bob).list('goals')).items).toHaveLength(1);
    expect((await scoped(store, bob).list('modelProviders')).items).toHaveLength(1);
    // The "deleting" marker survives the wipe (it goes last), for alice as for bob.
    expect(await scoped(store, alice).get('accountDeletions', alice)).not.toBeNull();
    expect(await deleteOwnerRows(db, alice)).toEqual({});
    await expect(deleteOwnerRows(db, '  ')).rejects.toThrow('an owner id is required');
  });

  it('deletes an owner\'s events except the kept types, and no other owner\'s', async () => {
    const { store, db } = await open();
    const [alice, bob] = [uid('alice'), uid('bob')];
    for (const owner of [alice, bob]) {
      await scoped(store, owner).emit({ type: 'agent.deleted', agentId: `agt-${owner}` });
      await scoped(store, owner).emit({ type: 'conversation.deleted', conversationId: `conv-${owner}` });
      await scoped(store, owner).emit({ type: 'goal.deleted', goalId: `goal-${owner}` });
    }
    expect(await deleteOwnerEvents(db, alice, ['agent.deleted', 'conversation.deleted'])).toBe(1);
    const left = await db.query<{ owner_id: string; type: string }>('SELECT owner_id, type FROM events WHERE owner_id IN (?, ?) ORDER BY id', [alice, bob]);
    expect(left.map((row) => `${row.owner_id === alice ? 'alice' : 'bob'}:${row.type}`)).toEqual([
      'alice:agent.deleted', 'alice:conversation.deleted', 'bob:agent.deleted', 'bob:conversation.deleted', 'bob:goal.deleted',
    ]);
    expect(await deleteOwnerEvents(db, alice, ['agent.deleted', 'conversation.deleted'])).toBe(0);
  });

  it('closes one user\'s sign-in, then removes the user row; another user is untouched', async () => {
    const { db } = await open();
    const [alice, bob] = [uid('alice'), uid('bob')];
    const seedUser = async (id: string): Promise<void> => {
      await db.query('INSERT INTO auth_user (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)', [id, id, `${id}@example.com`, 0, AT, AT]);
      await db.query('INSERT INTO auth_session (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)', [`s-${id}`, AT, `t-${id}`, AT, AT, id]);
      await db.query('INSERT INTO auth_account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)', [`a-${id}`, id, 'credential', id, 'hash', AT, AT]);
      await db.query('INSERT INTO auth_verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)', [`v-${id}`, `reset-password:${id}`, id, AT, AT, AT]);
      await db.query('INSERT INTO "auth_deviceCode" (id, "deviceCode", "userCode", "userId", "expiresAt", status) VALUES (?, ?, ?, ?, ?, ?)', [`d-${id}`, `dc-${id}`, `uc-${id}`, id, AT, 'approved']);
    };
    await seedUser(alice);
    await seedUser(bob);
    const rowsOf = async (user: string) => ({
      sessions: (await db.query('SELECT id FROM auth_session WHERE "userId" = ?', [user])).length,
      accounts: (await db.query('SELECT id FROM auth_account WHERE "userId" = ?', [user])).length,
      deviceCodes: (await db.query('SELECT id FROM "auth_deviceCode" WHERE "userId" = ?', [user])).length,
      verifications: (await db.query('SELECT id FROM auth_verification WHERE value = ?', [user])).length,
    });
    expect(await closeAuthAccount(db, alice)).toEqual({ sessions: 1, accounts: 1, deviceCodes: 1, verifications: 1 });
    expect(await rowsOf(alice)).toEqual({ sessions: 0, accounts: 0, deviceCodes: 0, verifications: 0 });
    expect(await rowsOf(bob)).toEqual({ sessions: 1, accounts: 1, deviceCodes: 1, verifications: 1 });
    expect(await db.query('SELECT id FROM auth_user WHERE id IN (?, ?)', [alice, bob])).toHaveLength(2);
    expect(await closeAuthAccount(db, alice)).toEqual({ sessions: 0, accounts: 0, deviceCodes: 0, verifications: 0 });
    expect(await deleteAuthUser(db, alice)).toBe(true);
    expect(await deleteAuthUser(db, alice)).toBe(false);
    expect((await db.query('SELECT id FROM auth_user WHERE id IN (?, ?)', [alice, bob])).map((row) => row['id'])).toEqual([bob]);
  });

  it('reports exactly the keys that some other owner\'s upload, artifact file or transcript still names', async () => {
    const { store, db } = await open();
    const [alice, bob] = [uid('alice'), uid('bob')];
    const keys = { unique: blobKey(), sharedUpload: blobKey(), sharedTranscript: blobKey(), sharedArtifact: blobKey() };
    await scoped(store, bob).put('library', { id: uid('lib'), blobKey: keys.sharedUpload } as never);
    await scoped(store, bob).put('transcripts', { id: uid('tr'), sessionKey: 'agt:conv', seq: 1, compactionEpoch: 0, at: AT, message: { role: 'user', content: [{ type: 'image', blobKey: keys.sharedTranscript }] } });
    await scoped(store, bob).put('artifactFiles', { id: uid('af'), artifactId: 'x', version: 1, part: 'file', name: 'n', mimeType: 'text/plain', sizeBytes: 1, sha256: 's', blobKey: keys.sharedArtifact, createdAt: AT });
    // Alice's own rows naming her keys never count as "other".
    await scoped(store, alice).put('library', { id: uid('lib'), blobKey: keys.unique } as never);
    await scoped(store, alice).put('library', { id: uid('lib'), blobKey: keys.sharedUpload } as never);
    const used = await blobKeysUsedByOthers(db, alice, Object.values(keys));
    expect([...used].sort()).toEqual([keys.sharedArtifact, keys.sharedTranscript, keys.sharedUpload].sort());
    expect((await blobKeysUsedByOthers(db, bob, [keys.unique])).has(keys.unique)).toBe(true);
    expect((await blobKeysUsedByOthers(db, alice, [])).size).toBe(0);
  });

  it('finds keys in more than one scan (more than 50 keys at once)', async () => {
    const { store, db } = await open();
    const [alice, bob] = [uid('alice'), uid('bob')];
    const keys = Array.from({ length: 120 }, blobKey);
    await scoped(store, bob).put('library', { id: uid('lib'), blobKey: keys[119] } as never);
    expect([...(await blobKeysUsedByOthers(db, alice, keys))]).toEqual([keys[119]]);
  });
});
