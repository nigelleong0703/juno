/**
 * Discord voice across processes (BACKEND 2.2c). The gateway session, and with it every voice connection, lives in the
 * coordinator; the voice tools run on whichever worker claimed the run. A worker therefore gets a `VoicePort` that writes a
 * `voiceCalls` row and polls it, and the coordinator serves those rows with its real port.
 *
 * A call nobody picks up within `PICKUP_MS` fails with a clear message and its row is removed, so a coordinator that comes back
 * later never runs a request whose tool already gave up. A call that was picked up but not answered in time may or may not have
 * happened; the message says so, and the transcript tool shows whether the bot is in the channel.
 */
import { randomUUID } from 'node:crypto';
import { patchWhen, type Store, type VoiceCallRow, type VoiceOp } from '../../../contracts/index.js';
import { pollFor } from '../../../execution/poll.js';
import type { VoicePort, VoiceReply } from './discordVoice.js';

/** How long the coordinator has to pick a call up. */
export const VOICE_PICKUP_MS = 5_000;
/** How long a picked-up call may take (joining a channel waits for Discord's voice handshake). */
export const VOICE_ANSWER_MS = 60_000;
const SERVE_POLL_MS = 300;
const STALE_ROW_MS = 5 * 60_000;

const NOT_REACHABLE: VoiceReply = { ok: false, error: 'the Discord voice service is not reachable right now (the process that holds the Discord connection did not answer), so nothing was done' };
const NO_ANSWER: VoiceReply = { ok: false, error: 'the Discord voice service did not answer in time, so this may or may not have happened; use discord_voice_transcript to see whether I am in a voice channel' };

/** The port a worker's tools use: every call goes through the database to the coordinator. */
export function createRemoteVoicePort(store: Store, timeouts: { pickupMs?: number; answerMs?: number; pollMs?: number } = {}): VoicePort {
  const pickupMs = timeouts.pickupMs ?? VOICE_PICKUP_MS;
  const answerMs = timeouts.answerMs ?? VOICE_ANSWER_MS;
  const pollMs = timeouts.pollMs ?? 100;
  const call = async (op: VoiceOp, ownerId: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<VoiceReply> => {
    const id = 'vc_' + randomUUID();
    const startedAt = Date.now();
    await store.put('voiceCalls', { id, ownerId, op, input, status: 'pending', createdAt: new Date(startedAt).toISOString() });
    try {
      const waited = await pollFor<VoiceReply | 'unreachable'>(async () => {
        const row = await store.get('voiceCalls', id);
        if (row?.status === 'done' && row.reply !== undefined) return row.reply;
        if (row?.status === 'pending' && Date.now() - startedAt > pickupMs) return 'unreachable';
        return undefined;
      }, { timeoutMs: answerMs, intervalMs: pollMs, ...(signal === undefined ? {} : { signal }) });
      if (waited.kind === 'aborted') return await stoppedWaiting(id);
      if (waited.kind !== 'value') return NO_ANSWER;
      return waited.value === 'unreachable' ? NOT_REACHABLE : waited.value;
    } finally {
      await store.delete('voiceCalls', id).catch(() => undefined);
    }
  };
  /** The run was stopped while waiting: a call the coordinator never picked up is withdrawn (the delete below), one it has started cannot be recalled. */
  const stoppedWaiting = async (id: string): Promise<VoiceReply> => {
    const row = await store.get('voiceCalls', id);
    return row?.status === 'pending' || row === null
      ? { ok: false, error: 'the run was stopped before the Discord voice service started this, so nothing was done' }
      : { ok: false, error: 'the run was stopped while the Discord voice service was doing this, so it may or may not have happened; use discord_voice_transcript to see whether I am in a voice channel' };
  };
  return {
    join: (input, signal) => call('join', input.ownerId, { ...input }, signal),
    leave: (input, signal) => call('leave', input.ownerId, { ...input }, signal),
    transcript: (input, signal) => call('transcript', input.ownerId, { ...input }, signal),
  };
}

type Join = Parameters<VoicePort['join']>[0];
type Leave = Parameters<VoicePort['leave']>[0];
type Transcript = Parameters<VoicePort['transcript']>[0];

function run(port: VoicePort, row: VoiceCallRow): Promise<VoiceReply> {
  switch (row.op) {
    case 'join': return port.join(row.input as unknown as Join);
    case 'leave': return port.leave(row.input as unknown as Leave);
    case 'transcript': return port.transcript(row.input as unknown as Transcript);
  }
}

/** One pass: claim each pending call under the row lock, run it on the real port, write the reply. Returns how many it served. */
export async function serveVoiceCallsOnce(store: Store, port: VoicePort): Promise<number> {
  const pending = await store.list('voiceCalls', { where: { status: 'pending' }, limit: 20 });
  // Calls run side by side: a join waits for Discord's handshake and must not hold the pickup of the next one.
  const results = await Promise.all(pending.items.map(async (row): Promise<number> => {
    const claimed = await patchWhen(store, 'voiceCalls', row.id, (current) => current.status === 'pending', { status: 'running' });
    if (claimed === undefined) return 0;
    let reply: VoiceReply;
    try {
      reply = await run(port, row);
    } catch (error) {
      reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    // The asking tool may have given up and deleted the row; then there is nobody to tell.
    await patchWhen(store, 'voiceCalls', row.id, (current) => current.status === 'running', { status: 'done', reply });
    return 1;
  }));
  const served = results.reduce((sum, n) => sum + n, 0);
  const old = await store.list('voiceCalls', { where: { status: 'running' }, limit: 20 });
  for (const row of old.items) if (Date.now() - Date.parse(row.createdAt) > STALE_ROW_MS) await store.delete('voiceCalls', row.id).catch(() => undefined);
  return served;
}

/** The coordinator's loop. Returns the stop function. */
export function serveVoiceCalls(store: Store, port: VoicePort, intervalMs: number = SERVE_POLL_MS): () => void {
  // Passes may overlap: the claim is a row-locked compare-and-set, so a call is run once, and a slow join never delays the next pickup.
  const timer = setInterval(() => {
    serveVoiceCallsOnce(store, port).catch(() => undefined);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
