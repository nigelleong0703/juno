/**
 * What the coordinator writes and execution workers read (BACKEND 2.2c), with two store connections on one Postgres standing in for the
 * two processes: the owner's presence and the iPhone's declaration, an iPhone call answered through the coordinator, and a Discord voice
 * tool call served by the coordinator that holds the gateway.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Store } from '@agent-desktop/contracts';
import { buildPhoneSection, callPhone, completePhoneCall, declarePhone, phoneRefusal, PHONE_CLOSED } from 'juno-agent/execution/phone';
import { PRESENCE_TTL_MS, connectClient, presenceLine, readPresence, resetPresence, watchScreen } from 'juno-agent/execution/presence';
import { createRemoteVoicePort, serveVoiceCallsOnce } from 'juno-agent/modules/tools/tools/discordVoiceRemote';
import { closeScratchPostgres, scratchPostgresUrl, uid } from './store-backends';
import { createPostgresStore } from '../postgres-store.js';

type PostgresStore = Awaited<ReturnType<typeof createPostgresStore>>;
let coordinator: PostgresStore;
let worker: PostgresStore;

beforeAll(async () => {
  const url = await scratchPostgresUrl();
  coordinator = await createPostgresStore(url);
  worker = await createPostgresStore(url);
});
afterAll(async () => {
  resetPresence();
  await coordinator.close();
  await worker.close();
  await closeScratchPostgres();
});

/** The worker's handle on the shared database; the device event it emits has no agent to resolve an owner from, so it is dropped. */
const workerWithoutEvents = (): Store => ({ ...worker, emit: async () => undefined });
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe('presence and the iPhone, written by the coordinator and read by a worker', () => {
  it('shows the worker the open app, the watched screen and the iPhone declaration; closing the stream takes them away', async () => {
    const owner = uid('owner');
    const leave = await connectClient(coordinator, owner, 'ios');
    await watchScreen(coordinator, owner, 'agent-1', true);
    await declarePhone(coordinator, owner, { deviceId: 'phone-1', name: 'Phone', osVersion: 'iOS 26', actions: ['calendar.read'] });

    expect(await presenceLine(worker, owner, 'agent-1')).toBe('The user has the iPhone app open right now and is watching your screen.');
    expect(await presenceLine(worker, owner, 'agent-2')).toBe('The user has the iPhone app open right now.');
    expect(await phoneRefusal(worker, owner, 'calendar.list_events')).toBeUndefined();
    expect(await buildPhoneSection(worker, owner)).toContain('calendar.read');

    await leave();
    expect(await presenceLine(worker, owner, 'agent-1')).toMatch(/^The user is not in the app \(last active just now\)/);
    expect(await phoneRefusal(worker, owner, 'calendar.list_events')).toBe(PHONE_CLOSED);
  });

  it('reads a stream whose coordinator stopped writing as closed, not as still open', async () => {
    const owner = uid('owner');
    await connectClient(coordinator, owner, 'web');
    expect((await readPresence(worker, owner))?.clients).toEqual(['web']);
    const dead = await readPresence(worker, owner, Date.now() + PRESENCE_TTL_MS + 1_000);
    expect(dead?.clients).toEqual([]);
    expect(await presenceLine(worker, owner, 'agent-1', Date.now() + PRESENCE_TTL_MS + 1_000)).toContain('not in the app');
  });

  it('carries a call from a worker to the app and the app\'s answer, received by the coordinator, back to that worker', async () => {
    const owner = uid('owner');
    await connectClient(coordinator, owner, 'ios');
    await declarePhone(coordinator, owner, { deviceId: 'phone-1', name: 'Phone', osVersion: 'iOS 26', actions: ['calendar.read'] });
    const callId = uid('call');
    const waiting = callPhone({ ownerId: owner, agentId: 'a1', callId, action: 'calendar.list_events', args: {}, store: workerWithoutEvents(), timeoutMs: 5_000 });
    await tick();
    // The POST lands on the coordinator, twice: the second answer is not applied.
    expect(await completePhoneCall(coordinator, owner, callId, { ok: true, data: ['Dentist'] })).toBe(true);
    expect(await completePhoneCall(coordinator, owner, callId, { ok: true, data: ['Again'] })).toBe(false);
    expect(await waiting).toEqual({ kind: 'done', result: { ok: true, data: ['Dentist'] } });
    // The worker removed its call row.
    expect(await worker.get('phoneCalls', callId)).toBeNull();
  });

  it('tells a waiting worker the call is lost when the app disconnects', async () => {
    const owner = uid('owner');
    const leave = await connectClient(coordinator, owner, 'ios');
    await declarePhone(coordinator, owner, { deviceId: 'phone-1', name: 'Phone', osVersion: 'iOS 26', actions: ['calendar.read'] });
    const waiting = callPhone({ ownerId: owner, agentId: 'a1', callId: uid('call'), action: 'calendar.list_events', args: {}, store: workerWithoutEvents(), timeoutMs: 5_000 });
    await tick();
    await leave();
    expect(await waiting).toEqual({ kind: 'lost' });
  });
});

describe('Discord voice tools on a worker, served by the coordinator', () => {
  const voice = (log: string[]) => ({
    join: async (input: { agentId: string }) => { log.push('join ' + input.agentId); return { ok: true as const, text: 'Joined the room' }; },
    leave: async () => ({ ok: true as const, text: 'Left' }),
    transcript: async () => ({ ok: false as const, error: 'I am not in a voice channel' }),
  });

  it('runs the call on the coordinator once and returns its reply to the worker', async () => {
    const log: string[] = [];
    const remote = createRemoteVoicePort(worker, { pollMs: 20 });
    const asking = remote.join({ ownerId: 'owner-v', agentId: 'agent-v', conversationId: 'c1' });
    await tick(30);
    // Two coordinator passes at once (a restart overlap): the row lock lets one run it.
    const served = await Promise.all([serveVoiceCallsOnce(coordinator, voice(log)), serveVoiceCallsOnce(coordinator, voice(log))]);
    expect(served.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(await asking).toEqual({ ok: true, text: 'Joined the room' });
    expect(log).toEqual(['join agent-v']);
    const failing = remote.transcript({ ownerId: 'owner-v', agentId: 'agent-v' });
    await tick(30);
    await serveVoiceCallsOnce(coordinator, voice(log));
    expect(await failing).toEqual({ ok: false, error: 'I am not in a voice channel' });
  });

  it('withdraws a call the run stopped before any coordinator started it, and says a started one may have happened', async () => {
    const remote = createRemoteVoicePort(worker, { pollMs: 20 });
    const stop = new AbortController();
    const asking = remote.join({ ownerId: 'owner-v', agentId: 'agent-v', conversationId: 'c1' }, stop.signal);
    await tick(30);
    stop.abort();
    const reply = await asking;
    expect(reply.ok === false && reply.error).toContain('nothing was done');
    // Nothing is left for a coordinator to run afterwards.
    const log: string[] = [];
    expect(await serveVoiceCallsOnce(coordinator, voice(log))).toBe(0);
    expect(log).toEqual([]);

    // A call a coordinator is already running cannot be recalled.
    const started = new AbortController();
    const slowVoice = { ...voice(log), join: async () => { await tick(150); return { ok: true as const, text: 'Joined' }; } };
    const running = remote.join({ ownerId: 'owner-v', agentId: 'agent-v', conversationId: 'c1' }, started.signal);
    await tick(30);
    const serving = serveVoiceCallsOnce(coordinator, slowVoice);
    await tick(60);
    started.abort();
    const stoppedReply = await running;
    expect(stoppedReply.ok === false && stoppedReply.error).toContain('may or may not have happened');
    await serving;
  });

  it('fails clearly, and leaves nothing to run later, when no coordinator picks the call up', async () => {
    const remote = createRemoteVoicePort(worker, { pickupMs: 100, pollMs: 20 });
    const reply = await remote.leave({ ownerId: 'owner-v', agentId: 'agent-v' });
    expect(reply.ok).toBe(false);
    expect(reply.ok === false && reply.error).toContain('not reachable');
    const log: string[] = [];
    expect(await serveVoiceCallsOnce(coordinator, voice(log))).toBe(0);
  });
});
