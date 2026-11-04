/**
 * Files and the outside-members rule on the agentd side, with fake platforms (no live network):
 *  - the files of an inbound message land in the owner's library, through the platform's own attachment call (inbound files);
 *  - a file sent from a platform chat goes through the platform's file call (outbound files);
 *  - a Feishu app's optional scopes are written to its row from what Feishu answers (the grants writer);
 *  - a group with outside members speaks only where it was addressed (the quiet rule).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { ChannelRow, Store } from '@agent-desktop/contracts';
import type { ChannelOrigin, Conversation } from '@agent-desktop/public-contracts';
import { createMemoryBlobStore } from 'juno-agent/testing/blobs';
import { clearFeishuTokenCache } from '@agent-desktop/channels/feishu/api';
import { storeInboundFiles } from '../files.js';
import { recordFeishuOutcome, syncFeishuGroupGrant } from '../feishu/grants.js';
import { holdsQuietReply } from '../origin.js';
import { planRunOutputs, sendOutputRow } from '../outputs.js';
import { saveBlob } from '@agent-desktop/contracts';
import { createChannelPort } from '../port.js';
import { testChannels } from '../../__tests__/test-app.js';

const OWNER = 'owner-1';
const AT = '2026-10-26T10:00:00.000Z';

interface Call { url: string; method: string; auth: string | null; body: unknown }

/** A fake platform: `reply(call)` answers; bytes come back for a download, JSON for everything else. */
function fakePlatform(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const raw = init?.body;
    const body = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw instanceof FormData ? raw : raw ?? null;
    const call: Call = { url: String(input), method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('authorization'), body };
    calls.push(call);
    return reply(call);
  };
  return { fetchFn, calls };
}

async function setup(kind: string, row: Partial<ChannelRow> = {}): Promise<Store> {
  const store = createMemoryStore();
  await store.put('agents', { id: 'agent-1', name: 'Nova', createdBy: OWNER, ownerId: OWNER } as never);
  await store.put('channels', { id: kind + ':chan-1', ownerId: OWNER, agentId: 'agent-1', kind, channelId: 'chan-1', secretHashHex: 'h', botToken: 'tok', botUserId: 'BOT', ownerExternalId: 'UOWNER', createdAt: AT, updatedAt: AT, ...row } as never);
  return store;
}

const groupOrigin = (kind: string): ChannelOrigin => ({ kind, channelId: 'chan-1', chatId: 'C1', threadId: 'C1', chatType: 'group' });

async function rowOf(store: Store, id: string): Promise<ChannelRow> {
  const row = await store.get('channels', id);
  if (row === null) throw new Error('channel row missing: ' + id);
  return row;
}

beforeEach(() => clearFeishuTokenCache());

describe('inbound files', () => {
  it('stores each file in the owner\'s library (an upload row, the bytes in the blob store) and returns the ids the wake names', async () => {
    const store = await setup('discord');
    const blobs = createMemoryBlobStore();
    const bytes = new TextEncoder().encode('line one\nline two');
    const { fetchFn, calls } = fakePlatform(() => new Response(bytes, { headers: { 'content-type': 'text/plain' } }));
    const row = await rowOf(store, 'discord:chan-1');
    const stored = await storeInboundFiles({ store, channels: testChannels, channelFetch: fetchFn, blobs }, OWNER, row, [
      { fileId: 'https://cdn.discordapp.com/attachments/1/2/log.txt', name: 'log.txt', mimeType: 'text/plain', sizeBytes: bytes.length },
    ], 'M5');
    expect(calls.map((call) => call.url)).toEqual(['https://cdn.discordapp.com/attachments/1/2/log.txt']);
    expect(stored.ids).toHaveLength(1);
    expect(stored.attachments).toEqual([{ id: stored.ids[0], name: 'log.txt', kind: 'file', mimeType: 'text/plain', sizeBytes: bytes.length }]);
    const doc = await store.forOwner?.(OWNER).get('library', stored.ids[0] ?? '');
    expect(doc).toMatchObject({ name: 'log.txt', source: 'upload', sizeBytes: bytes.length, shared: 'private' });
    expect(typeof (doc as { blobKey?: unknown } | null)?.blobKey).toBe('string');
  });

  it('stores nothing without a blob store, and skips a file the platform will not give without failing the others', async () => {
    const store = await setup('discord');
    const row = await rowOf(store, 'discord:chan-1');
    const { fetchFn } = fakePlatform(() => new Response('x'));
    expect(await storeInboundFiles({ store, channels: testChannels, channelFetch: fetchFn }, OWNER, row, [{ fileId: 'https://cdn.discordapp.com/a', name: 'a' }], 'M1')).toEqual({ attachments: [], ids: [] });
    const blobs = createMemoryBlobStore();
    const refusing = fakePlatform(() => new Response('gone', { status: 404 }));
    expect(await storeInboundFiles({ store, channels: testChannels, channelFetch: refusing.fetchFn, blobs }, OWNER, row, [{ fileId: 'https://cdn.discordapp.com/a', name: 'a' }], 'M1')).toEqual({ attachments: [], ids: [] });
  });
});

describe('outbound files from a platform chat', () => {
  it('sends the file through the platform\'s file call on the origin chat, with the row\'s credentials', async () => {
    const store = await setup('telegram');
    const { fetchFn, calls } = fakePlatform(() => Response.json({ ok: true, result: { message_id: 88 } }));
    const port = createChannelPort({ store, channels: testChannels, channelFetch: fetchFn });
    const sent = await port.sendFile?.({ ownerId: OWNER, origin: { kind: 'telegram', channelId: 'chan-1', chatId: 'C1', threadId: 'C1:9', chatType: 'group' }, file: { name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([104, 105]) } });
    expect(sent).toEqual({ status: 'ok', value: { messageId: '88' } });
    expect(calls.map((call) => [call.method, call.url])).toEqual([['POST', 'https://api.telegram.org/bottok/sendDocument']]);
  });

  it('answers unsupported for another owner\'s channel, and nothing is sent', async () => {
    const store = await setup('telegram');
    const { fetchFn, calls } = fakePlatform(() => Response.json({ ok: true }));
    const port = createChannelPort({ store, channels: testChannels, channelFetch: fetchFn });
    expect(await port.sendFile?.({ ownerId: 'someone-else', origin: { kind: 'telegram', channelId: 'chan-1', chatId: 'C1', threadId: 'C1', chatType: 'group' }, file: { name: 'a.txt', mime: 'text/plain', bytes: new Uint8Array([1]) } })).toEqual({ status: 'unsupported' });
    expect(calls).toHaveLength(0);
  });
});

describe('what a finished run made reaches its thread (BACKEND 6.8)', () => {
  async function runThatMadeADocument(store: Store, blobs: ReturnType<typeof createMemoryBlobStore>) {
    const conv = { id: 'cvn-g', kind: 'room', agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT, ownerId: OWNER, channel: { kind: 'telegram', channelId: 'chan-1', chatId: 'C1', threadId: 'C1' } };
    // The owner's rows (the delivery reads them through the owner's scope).
    const owned = store.forOwner?.(OWNER) ?? store;
    await owned.put('conversations', conv as never);
    await owned.put('runs', { id: 'run-1', agentId: 'agent-1', conversationId: 'cvn-g' } as never);
    await owned.put('runs', { id: 'run-child', agentId: 'agent-1', conversationId: 'cvn-g', parentRunId: 'run-1' } as never);
    const stored = await saveBlob(blobs, new TextEncoder().encode('# Launch checklist'), 'text/markdown');
    await owned.put('artifactFiles', { id: 'af-1', artifactId: 'lib-1', version: 1, part: 'file', name: 'checklist.md', mimeType: 'text/markdown', sizeBytes: stored.sizeBytes, sha256: stored.sha256, blobKey: stored.blobKey, createdAt: AT } as never);
    const version = { version: 1, fileRef: 'af-1', mimeType: 'text/markdown' };
    // One made by the child of the run, one by another run (not this run's), and a file with no versions (send_file posts its own).
    await owned.put('library', { id: 'lib-1', name: 'Launch checklist', kind: 'document', mimeType: 'text/markdown', conversationId: 'cvn-g', runId: 'run-child', version: 1, versions: [version] } as never, { conversationId: 'cvn-g' });
    // A background task of this thread's earlier work that finished after that run did: its run row names this thread as the root.
    await owned.put('runs', { id: 'run-bg', agentId: 'agent-1', conversationId: 'cvn-g', parentRunId: 'run-earlier', rootOrigin: { type: 'channel', channel: 'telegram', conversationId: 'cvn-g', speaker: 'member' } } as never);
    await owned.put('library', { id: 'lib-bg', name: 'Background notes', kind: 'document', mimeType: 'text/markdown', conversationId: 'cvn-g', runId: 'run-bg', version: 1, versions: [version] } as never, { conversationId: 'cvn-g' });
    await owned.put('library', { id: 'lib-other', name: 'Other', kind: 'document', mimeType: 'text/markdown', conversationId: 'cvn-g', runId: 'run-other', version: 1, versions: [version] } as never, { conversationId: 'cvn-g' });
    await owned.put('library', { id: 'lib-plain', name: 'plain.txt', kind: 'file', conversationId: 'cvn-g', runId: 'run-1' } as never, { conversationId: 'cvn-g' });
    await owned.put('items', { id: 'itm-a', conversationId: 'cvn-g', type: 'agent_message', at: AT, agentId: 'agent-1', markdown: 'Here you go', citations: [], runId: 'run-1', replyTo: groupOrigin('telegram') } as never, { conversationId: 'cvn-g' });
  }

  const RUN = { id: 'run-1', agentId: 'agent-1', conversationId: 'cvn-g' };
  /** The outbox rows the run's documents became, each tried once. */
  async function sendQueued(deps: Parameters<typeof sendOutputRow>[0]) {
    const rows = (await deps.store.list('outbox', { where: { status: 'pending' }, orderBy: 'at', order: 'asc', limit: 20 })).items;
    return Promise.all(rows.map((row) => sendOutputRow(deps, row)));
  }

  it('queues the documents the run (and its child) made for the thread its answer went to, once; others\' and plain files are left alone; each row posts its file', async () => {
    const store = await setup('telegram');
    const blobs = createMemoryBlobStore();
    await runThatMadeADocument(store, blobs);
    const { fetchFn, calls } = fakePlatform(() => Response.json({ ok: true, result: { message_id: 90 } }));
    const deps = { store, blobs, channels: testChannels, channelFetch: fetchFn };
    expect(await planRunOutputs(deps, OWNER, RUN)).toBe(2);
    // A second run event, or a restart, queues nothing twice.
    expect(await planRunOutputs(deps, OWNER, RUN)).toBe(0);
    expect((await store.list('outbox', { limit: 10 })).items.map((row) => row.id).sort()).toEqual(['obx:out:lib-1:1', 'obx:out:lib-bg:1']);
    expect(await sendQueued(deps)).toEqual([{ status: 'sent', externalId: '90' }, { status: 'sent', externalId: '90' }]);
    expect(calls.map((call) => call.url)).toEqual(['https://api.telegram.org/bottok/sendDocument', 'https://api.telegram.org/bottok/sendDocument']);
  });

  it('queues nothing for a run that answered in no group, and a file the platform refuses is a failed attempt (the outbox retries it)', async () => {
    const store = await setup('telegram');
    const blobs = createMemoryBlobStore();
    await runThatMadeADocument(store, blobs);
    const refused = fakePlatform(() => Response.json({ ok: false, description: 'nope' }));
    const deps = { store, blobs, channels: testChannels, channelFetch: refused.fetchFn };
    expect(await planRunOutputs(deps, OWNER, RUN)).toBe(2);
    expect(await sendQueued(deps)).toMatchObject([{ status: 'failed', failure: { kind: 'transient' } }, { status: 'failed' }]);
    const empty = await setup('telegram');
    expect(await planRunOutputs({ store: empty }, OWNER, { id: 'run-nobody', agentId: 'agent-1', conversationId: 'cvn-none' })).toBe(0);
  });

  it('a run whose words went out without an answer item (send_message) still queues its document for the thread the conversation is bound to', async () => {
    const store = await setup('telegram');
    const blobs = createMemoryBlobStore();
    await runThatMadeADocument(store, blobs);
    const owned = store.forOwner?.(OWNER) ?? store;
    await owned.delete('items', 'itm-a');
    expect(await planRunOutputs({ store }, OWNER, RUN)).toBe(2);
  });
});

describe('the Feishu grants writer', () => {
  const feishuRow = { botToken: 'secret', domain: 'feishu' } as Partial<ChannelRow>;
  const tokenFor = (call: Call): Response | undefined => call.url.endsWith('/tenant_access_token/internal') ? Response.json({ code: 0, tenant_access_token: 't-1', expire: 7200 }) : undefined;

  it('records the group-message scope when a history read works, and takes it off when Feishu refuses for a missing scope', async () => {
    const store = await setup('feishu', feishuRow);
    const answer = { denied: false };
    const { fetchFn } = fakePlatform((call) => tokenFor(call) ?? (answer.denied
      ? Response.json({ code: 99991672, msg: 'Access denied. scope im:message.group_msg' })
      : Response.json({ code: 0, data: { items: [] } })));
    const port = createChannelPort({ store, channels: testChannels, channelFetch: fetchFn });
    expect((await port.history({ ownerId: OWNER, agentId: 'agent-1', origin: groupOrigin('feishu'), limit: 5 })).status).toBe('ok');
    expect((await rowOf(store, 'feishu:chan-1')).grantedScopes).toEqual(['im:message.group_msg']);
    answer.denied = true;
    expect((await port.history({ ownerId: OWNER, agentId: 'agent-1', origin: groupOrigin('feishu'), limit: 5 })).status).toBe('failed');
    expect((await rowOf(store, 'feishu:chan-1')).grantedScopes).toEqual([]);
  });

  it('records the reactions scope on a reaction that works; other failures change nothing', async () => {
    const store = await setup('feishu', feishuRow);
    await recordFeishuOutcome(store, await rowOf(store, 'feishu:chan-1'), 'im:message.reactions:write_only', { status: 'ok' });
    expect((await rowOf(store, 'feishu:chan-1')).grantedScopes).toEqual(['im:message.reactions:write_only']);
    await recordFeishuOutcome(store, await rowOf(store, 'feishu:chan-1'), 'im:message.reactions:write_only', { status: 'failed', error: 'Feishu reaction failed: 230001 bad request' });
    expect((await rowOf(store, 'feishu:chan-1')).grantedScopes).toEqual(['im:message.reactions:write_only']);
  });

  it('probes an unapproved group on its message and records the approval once Feishu answers', async () => {
    const store = await setup('feishu', feishuRow);
    const { fetchFn, calls } = fakePlatform((call) => tokenFor(call) ?? Response.json({ code: 0, data: { items: [] } }));
    await syncFeishuGroupGrant({ store, channels: testChannels, channelFetch: fetchFn }, await rowOf(store, 'feishu:chan-1'), { chatId: 'oc_1', threadId: 'oc_1' });
    expect(calls.some((call) => call.url.includes('/im/v1/messages?container_id_type=chat&container_id=oc_1'))).toBe(true);
    expect((await rowOf(store, 'feishu:chan-1')).grantedScopes).toEqual(['im:message.group_msg']);
    // Granted: no more probes.
    const before = calls.length;
    await syncFeishuGroupGrant({ store, channels: testChannels, channelFetch: fetchFn }, await rowOf(store, 'feishu:chan-1'), { chatId: 'oc_1', threadId: 'oc_1' });
    expect(calls.length).toBe(before);
  });
});

describe('the quiet rule for groups with outside members', () => {
  const room = (externalGroup?: boolean): Conversation & { externalGroup?: boolean } => ({
    id: 'cvn-1', kind: 'room', agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: AT, createdAt: AT,
    ...(externalGroup === undefined ? {} : { externalGroup }),
  });

  it('holds a reply that answers no platform message in an external group, and lets an addressed reply through', () => {
    expect(holdsQuietReply(room(true), {})).toBe(true);
    expect(holdsQuietReply(room(true), { replyTo: groupOrigin('slack') })).toBe(false);
    expect(holdsQuietReply(room(false), {})).toBe(false);
    expect(holdsQuietReply(room(), {})).toBe(false);
    expect(holdsQuietReply(null, {})).toBe(false);
  });
});
