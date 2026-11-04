/**
 * Push triggers. Events notify the owner's registered phones:
 *   - a new request that needs the user (approval, question, sign-in);
 *   - a top-level chat run that finished (completed or failed);
 *   - a routine that notifies (its notify is not `never`) whose run posted to the Feed (one push per run).
 * A trigger no longer sends: it queues one outbox row per phone (BACKEND 5.7.11), so a push can never block or fail the run that produced
 * the event, and a failed or interrupted push is retried by the outbox sender (`sendPushRow` is its one attempt). A restart queues what its
 * crash lost (`catchUp`, requests and finished runs of the last minutes; a feed brief has no row to read back, so one lost in a crash stays lost).
 */
import { createHash } from 'node:crypto';
import type { Store } from '@agent-desktop/contracts';
import type { AgentEvent, Run } from '@agent-desktop/public-contracts';
import type { OutboxRow } from 'juno-agent/contracts';
import { createLogger } from '@agent-desktop/log';
import type { ChannelDeliveryOutcome } from '../channels/delivery.js';
import { enqueueRow, pushRowId } from '../outbox/rows.js';
import { apnsConfigFromEnv, createApnsSender, type ApnsPayload, type PushSender } from './apns.js';
import { createFcmSender, fcmConfigFromEnv, type FcmPayload, type FcmSender } from './fcm.js';

const log = createLogger({ service: 'agentd' });

/**
 * Request kinds that wait on the user. `signin` is in the schema but no code path emits it yet. A take-over and a secure-input
 * request suspend the run until the person acts on their phone, so they must reach a person who is not looking at the chat.
 */
const NEEDS_USER_KINDS = new Set(['approval', 'question', 'computer', 'secure_input']);

/** APNs caps a payload at 4 KB; a long run or question title is clipped for the banner. */
const BODY_MAX = 180;

function clip(text: string): string {
  return text.length <= BODY_MAX ? text : text.slice(0, BODY_MAX - 1) + '\u2026';
}

export interface PushNotice {
  title: string;
  body: string;
  /** Deep-link ids the app reads from the notification payload. */
  data: { conversationId?: string; requestId?: string; runId?: string; screen?: 'feed'; routineId?: string };
}

/** Shown when the agent behind an event can't be read (deleted, or not visible to its owner's scope). */
const UNKNOWN_AGENT = 'Your agent';

/**
 * The notification for an event, or null when the event does not notify. Pure: no store, no sender. `agentName`
 * is the agent that raised the request or ran the run, so the banner names it ("Mira needs you").
 */
/** The durable run id a standard run-scoped event names, read from the Juno metadata. */
function runIdOf(event: AgentEvent): string | undefined {
  const metadata = (event as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const juno = (metadata as { juno?: unknown }).juno;
  if (typeof juno !== 'object' || juno === null) return undefined;
  const runId = (juno as { runId?: unknown }).runId;
  return typeof runId === 'string' ? runId : undefined;
}

/** The agent id a standard run-scoped event attributes, read from the Juno metadata. */
function junoAgentIdOf(event: AgentEvent): string | undefined {
  const metadata = (event as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const juno = (metadata as { juno?: unknown }).juno;
  if (typeof juno !== 'object' || juno === null) return undefined;
  const agentId = (juno as { agentId?: unknown }).agentId;
  return typeof agentId === 'string' ? agentId : undefined;
}

/** The notice for a request that waits on the user; null for the other kinds. */
export function requestNotice(request: { kind: string; title: string; summary?: string; id: string; conversationId?: string; runId?: string }, agentName: string = UNKNOWN_AGENT): PushNotice | null {
  if (!NEEDS_USER_KINDS.has(request.kind)) return null;
  // A take-over's title is generic; its summary is the instruction (what to do on the screen).
  const body = request.kind === 'computer' && request.summary ? request.summary : request.title;
  return {
    title: `${agentName} needs you`,
    body: clip(body),
    data: withDefined({ conversationId: request.conversationId, requestId: request.id, runId: request.runId }),
  };
}

/** The notice for a top-level chat run that completed or failed; null for anything else. Kind/title/status are durable product state, not wire fields: the caller passes the row. */
export function runNotice(run: Run | null | undefined, agentName: string = UNKNOWN_AGENT): PushNotice | null {
  if (run === undefined || run === null) return null;
  if (run.kind !== 'chat' || run.parentRunId !== undefined) return null;
  if (run.status !== 'completed' && run.status !== 'failed') return null;
  return {
    title: run.status === 'completed' ? agentName + ' finished' : agentName + ' could not finish',
    body: clip(run.title),
    data: withDefined({ conversationId: run.conversationId, runId: run.id }),
  };
}

export async function noticeFor(event: AgentEvent, agentName: string = UNKNOWN_AGENT, run?: Run | null): Promise<PushNotice | null> {
  if (event.type === 'request.created') return requestNotice(event.request, agentName);
  if (event.type === 'RUN_FINISHED') return runNotice(run, agentName);
  if (event.type === 'feed.brief') {
    if (!event.notify) return null;
    return {
      title: event.title,
      body: clip(event.postIds.length === 1 ? event.firstPostTitle : `${String(event.postIds.length)} new posts`),
      data: { screen: 'feed', routineId: event.routineId },
    };
  }
  return null;
}

function withDefined<T extends Record<string, string | undefined>>(values: T): Partial<Record<keyof T, string>> {
  const out: Partial<Record<keyof T, string>> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key as keyof T] = value;
  }
  return out;
}

function payloadFor(notice: PushNotice): ApnsPayload {
  return {
    aps: {
      alert: { title: notice.title, body: notice.body },
      sound: 'default',
      ...(notice.data.conversationId === undefined ? {} : { 'thread-id': notice.data.conversationId }),
    },
    ...notice.data,
  };
}

function fcmPayloadFor(notice: PushNotice): FcmPayload {
  return { title: notice.title, body: notice.body, data: Object.fromEntries(Object.entries(notice.data).filter(isDefinedEntry)) };
}

function isDefinedEntry(entry: [string, string | undefined]): entry is [string, string] {
  return entry[1] !== undefined;
}

/** The owner of the document an event is about, read from its stored doc (the store stamps ownerId). */
async function ownerOf(store: Store, event: AgentEvent): Promise<string | undefined> {
  const doc = event.type === 'request.created'
    ? await store.get('requests', event.request.id)
    : event.type === 'RUN_FINISHED'
      ? await store.get('runs', runIdOf(event) ?? '')
      : event.type === 'feed.brief'
        ? await store.get('routines', event.routineId)
        : null;
  const owner = (doc as { ownerId?: unknown } | null)?.ownerId;
  return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
}

/** The name of the agent an event is about, read in the owner's scope; the generic label when it can't be read. */
async function agentNameOf(scoped: Store, event: AgentEvent): Promise<string> {
  const agentId = event.type === 'request.created' ? event.request.agentId : event.type === 'RUN_FINISHED' ? junoAgentIdOf(event) : undefined;
  if (!agentId) return UNKNOWN_AGENT;
  const agent = await scoped.get('agents', agentId);
  const name = (agent as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : UNKNOWN_AGENT;
}

/** The senders of the platforms that are configured. A platform with none was logged once at startup; its devices get no notice. */
export interface PushSenders {
  /** APNs, for iOS devices. */
  ios?: Pick<PushSender, 'send'>;
  /** FCM, for Android devices. */
  android?: Pick<FcmSender, 'send'>;
}

export interface PushNotifier {
  /** Queue the notice an event raises, one outbox row per registered phone. Returns how many rows were made. Never throws. */
  handle(event: AgentEvent): Promise<number>;
  /** The start-up catch-up: notices of the last few minutes whose event was lost before its rows were made (a crash, a restart). */
  catchUp(sinceMs: number): Promise<number>;
}

/** The id a push row is made from: the request or run that raised it; a feed brief by its routine and posts. */
function sourceOf(event: AgentEvent): string | undefined {
  if (event.type === 'request.created') return event.request.id;
  if (event.type === 'RUN_FINISHED') return runIdOf(event);
  if (event.type === 'feed.brief') return 'brief:' + event.routineId + ':' + createHash('sha256').update(event.postIds.join(',')).digest('hex').slice(0, 16);
  return undefined;
}

/** The platform kind a device is pushed through. */
const platformOf = (device: { platform?: string }): 'ios' | 'android' => (device.platform === 'android' ? 'android' : 'ios');

export function createPushNotifier({ store, senders }: { store: Store; senders: PushSenders }): PushNotifier {
  /** One row per phone of the owner whose platform has a sender. */
  async function queue(scoped: Store, ownerId: string, sourceId: string, notice: PushNotice, at: string, ids: { agentId?: string; runId?: string }): Promise<number> {
    const devices = await scoped.list('devices', { limit: 100 });
    const now = new Date().toISOString();
    let queued = 0;
    for (const device of devices.items) {
      const platform = platformOf(device);
      if (senders[platform] === undefined) continue;
      const data = Object.fromEntries(Object.entries(notice.data).filter(isDefinedEntry));
      const made = await enqueueRow(store, {
        id: pushRowId(sourceId, device.id), ownerId, kind: 'push', sourceId, platform,
        ...(ids.agentId === undefined ? {} : { agentId: ids.agentId }), ...(ids.runId === undefined ? {} : { runId: ids.runId }),
        destination: { type: 'push', deviceId: device.id, notice: { title: notice.title, body: notice.body, data } }, at,
      }, now);
      if (made) queued += 1;
    }
    return queued;
  }
  return {
    async handle(event) {
      try {
        // A finished-run notice needs the durable run row (kind/title/status are product state).
        const runRow = event.type === 'RUN_FINISHED' ? await store.get('runs', runIdOf(event) ?? '') : null;
        if (await noticeFor(event, UNKNOWN_AGENT, runRow) === null) return 0;
        const owner = await ownerOf(store, event);
        const sourceId = sourceOf(event);
        if (owner === undefined || sourceId === undefined || typeof store.forOwner !== 'function') return 0;
        const scoped = store.forOwner(owner);
        const notice = await noticeFor(event, await agentNameOf(scoped, event), runRow);
        if (notice === null) return 0;
        return await queue(scoped, owner, sourceId, notice, new Date().toISOString(), { ...(junoAgentIdOf(event) === undefined ? {} : { agentId: junoAgentIdOf(event) as string }), ...(runIdOf(event) === undefined ? {} : { runId: runIdOf(event) as string }) });
      } catch (err) {
        log.warn({ err, eventType: event.type }, 'push notification skipped');
        return 0;
      }
    },
    async catchUp(sinceMs) {
      let queued = 0;
      try {
        if (typeof store.forOwner !== 'function') return 0;
        const since = new Date(sinceMs).toISOString();
        const nameOf = async (scoped: Store, agentId: string): Promise<string> => {
          const name = ((await scoped.get('agents', agentId)) as { name?: unknown } | null)?.name;
          return typeof name === 'string' && name.trim() !== '' ? name.trim() : UNKNOWN_AGENT;
        };
        for (const request of (await store.list('requests', { where: { status: 'pending' }, orderBy: 'at', order: 'desc', limit: 100 })).items) {
          const owner = (request as { ownerId?: string }).ownerId;
          if (owner === undefined || request.createdAt < since) continue;
          const scoped = store.forOwner(owner);
          const notice = requestNotice(request, await nameOf(scoped, request.agentId));
          if (notice !== null) queued += await queue(scoped, owner, request.id, notice, request.createdAt, { agentId: request.agentId, ...(request.runId === undefined ? {} : { runId: request.runId }) });
        }
        for (const status of ['completed', 'failed']) {
          for (const run of (await store.list('runs', { where: { status }, orderBy: 'at', order: 'desc', limit: 100 })).items) {
            const owner = (run as { ownerId?: string }).ownerId;
            if (owner === undefined || run.finishedAt === undefined || run.finishedAt < since) continue;
            const scoped = store.forOwner(owner);
            const notice = runNotice(run, await nameOf(scoped, run.agentId));
            if (notice !== null) queued += await queue(scoped, owner, run.id, notice, run.finishedAt, { agentId: run.agentId, runId: run.id });
          }
        }
      } catch (err) {
        log.warn({ err }, 'push catch-up skipped');
      }
      return queued;
    },
  };
}

export type PushAttempt = ChannelDeliveryOutcome;

/**
 * One attempt to push one row to its phone. A token the platform no longer knows is forgotten (the phone deregistered or reinstalled) and the row is
 * dropped for good; any other refusal or a transport error is tried again by the sender (APNs and FCM report them as `failed`, which covers 5xx, rate limits and timeouts).
 */
export async function sendPushRow(deps: { store: Store; senders: PushSenders }, row: OutboxRow): Promise<PushAttempt> {
  const destination = row.destination;
  if (destination.type !== 'push' || row.ownerId === undefined || typeof deps.store.forOwner !== 'function') return { status: 'skipped' };
  const scoped = deps.store.forOwner(row.ownerId);
  const device = await scoped.get('devices', destination.deviceId);
  if (device === null) return { status: 'skipped' };
  const notice: PushNotice = { title: destination.notice.title, body: destination.notice.body, data: destination.notice.data };
  const platform = platformOf(device);
  const sender = deps.senders[platform];
  if (sender === undefined) return { status: 'failed', error: 'push is not configured for ' + platform, failure: { kind: 'platform_unavailable' } };
  const outcome = platform === 'android'
    ? await (sender as Pick<FcmSender, 'send'>).send({ token: device.token }, fcmPayloadFor(notice))
    : await (sender as Pick<PushSender, 'send'>).send({ token: device.token, environment: device.environment }, payloadFor(notice));
  if (outcome === 'sent') return { status: 'sent' };
  if (outcome === 'invalid_token') {
    await scoped.delete('devices', device.id);
    return { status: 'failed', error: 'The platform no longer knows this device token', failure: { kind: 'token_invalid' } };
  }
  return { status: 'failed', error: 'The push service did not accept the notification', failure: { kind: 'transient' } };
}

/**
 * The senders of the platforms the environment configures (one log line each otherwise). Undefined when neither is: push is off and nothing is queued.
 */
export function createPushSenders(env: NodeJS.ProcessEnv): PushSenders | undefined {
  const onError = (message: string, detail: Record<string, unknown>): void => log.warn(detail, message);
  let ios: PushSender | undefined;
  let android: FcmSender | undefined;
  try {
    const config = apnsConfigFromEnv(env);
    if (config === null) log.info('APNs is not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY or APNS_KEY_PATH); iOS push is off');
    else ios = createApnsSender({ config, onError });
  } catch (err) {
    // A bad key path or PEM disables that platform's push; it must not stop agentd from booting.
    log.error({ err }, 'APNs key could not be loaded; iOS push is off');
  }
  try {
    const config = fcmConfigFromEnv(env);
    if (config === null) log.info('FCM is not configured (FCM_SERVICE_ACCOUNT); Android push is off');
    else android = createFcmSender({ config, onError });
  } catch (err) {
    log.error({ err }, 'FCM service account could not be loaded; Android push is off');
  }
  if (ios === undefined && android === undefined) return undefined;
  return { ...(ios === undefined ? {} : { ios }), ...(android === undefined ? {} : { android }) };
}
