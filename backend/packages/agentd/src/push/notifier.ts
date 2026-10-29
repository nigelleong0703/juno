/**
 * Push triggers. Two events notify the owner's registered phones:
 *   - a new request that needs the user (approval, question, sign-in);
 *   - a top-level chat run that finished (completed or failed);
 *   - a routine that notifies (its notify is not `never`) whose run posted to the Feed (one push per run).
 * Runs off the committed event log (see `startPushNotifications`), so a push can never block or fail
 * the run that produced the event. Every failure is logged and dropped.
 */
import type { Store } from '@agent-desktop/contracts';
import type { AgentEvent, Run } from '@agent-desktop/public-contracts';
import { createLogger } from '@agent-desktop/log';
import { apnsConfigFromEnv, createApnsSender, type ApnsPayload, type PushSender } from './apns.js';
import { createFcmSender, fcmConfigFromEnv, type FcmPayload, type FcmSender } from './fcm.js';

const log = createLogger({ service: 'agentd' });

/** Request kinds that wait on the user. `signin` is in the schema but no code path emits it yet. */
const NEEDS_USER_KINDS = new Set(['approval', 'question']);

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

export async function noticeFor(event: AgentEvent, agentName: string = UNKNOWN_AGENT, run?: Run | null): Promise<PushNotice | null> {
  if (event.type === 'request.created') {
    const request = event.request;
    if (!NEEDS_USER_KINDS.has(request.kind)) return null;
    return {
      title: `${agentName} needs you`,
      body: clip(request.title),
      data: withDefined({ conversationId: request.conversationId, requestId: request.id, runId: request.runId }),
    };
  }
  if (event.type === 'RUN_FINISHED') {
    // Kind/title/status are durable product state, not wire fields: the caller passes the row.
    if (run === undefined || run === null) return null;
    if (run.kind !== 'chat' || run.parentRunId !== undefined) return null;
    if (run.status !== 'completed' && run.status !== 'failed') return null;
    return {
      title: run.status === 'completed' ? agentName + ' finished' : agentName + ' could not finish',
      body: clip(run.title),
      data: withDefined({ conversationId: run.conversationId, runId: run.id }),
    };
  }
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

export interface PushNotifierDeps {
  store: Store;
  /** APNs, for iOS devices. Absent when APNs is not configured: iOS devices are skipped. */
  ios?: Pick<PushSender, 'send'>;
  /** FCM, for Android devices. Absent when FCM is not configured: Android devices are skipped. */
  android?: Pick<FcmSender, 'send'>;
}

export interface PushNotifier {
  handle(event: AgentEvent): Promise<void>;
}

export function createPushNotifier({ store, ios, android }: PushNotifierDeps): PushNotifier {
  return {
    async handle(event) {
      try {
        // A finished-run notice needs the durable run row (kind/title/status are product state).
        const runRow = event.type === 'RUN_FINISHED' ? await store.get('runs', runIdOf(event) ?? '') : null;
        if (await noticeFor(event, UNKNOWN_AGENT, runRow) === null) return;
        const owner = await ownerOf(store, event);
        if (owner === undefined || typeof store.forOwner !== 'function') return;
        const scoped = store.forOwner(owner);
        const notice = await noticeFor(event, await agentNameOf(scoped, event), runRow);
        if (notice === null) return;
        const devices = await scoped.list('devices', { limit: 100 });
        const apnsPayload = payloadFor(notice);
        const fcmPayload = fcmPayloadFor(notice);
        for (const device of devices.items) {
          // A platform with no sender configured was logged once at startup; its devices are skipped quietly.
          const outcome =
            device.platform === 'android'
              ? await android?.send({ token: device.token }, fcmPayload)
              : await ios?.send({ token: device.token, environment: device.environment }, apnsPayload);
          // The platform no longer knows this token: forget it so later pushes skip it.
          if (outcome === 'invalid_token') await scoped.delete('devices', device.id);
        }
      } catch (err) {
        log.warn({ err, eventType: event.type }, 'push notification skipped');
      }
    },
  };
}

/**
 * Wires the notifier to the unscoped event bus of this process. Each platform is on only when configured
 * (one log line each otherwise); with neither configured the subscription is skipped entirely.
 * Returns an unsubscribe for shutdown.
 */
export async function startPushNotifications(args: {
  store: Store;
  bus: { subscribe(onEvent: (stored: { event: AgentEvent }) => void): Promise<() => void> };
  env: NodeJS.ProcessEnv;
}): Promise<(() => void) | undefined> {
  const onError = (message: string, detail: Record<string, unknown>): void => log.warn(detail, message);
  let ios: PushSender | undefined;
  let android: FcmSender | undefined;
  try {
    const config = apnsConfigFromEnv(args.env);
    if (config === null) log.info('APNs is not configured (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY or APNS_KEY_PATH); iOS push is off');
    else ios = createApnsSender({ config, onError });
  } catch (err) {
    // A bad key path or PEM disables that platform's push; it must not stop agentd from booting.
    log.error({ err }, 'APNs key could not be loaded; iOS push is off');
  }
  try {
    const config = fcmConfigFromEnv(args.env);
    if (config === null) log.info('FCM is not configured (FCM_SERVICE_ACCOUNT); Android push is off');
    else android = createFcmSender({ config, onError });
  } catch (err) {
    log.error({ err }, 'FCM service account could not be loaded; Android push is off');
  }
  if (ios === undefined && android === undefined) return undefined;
  const notifier = createPushNotifier({ store: args.store, ios, android });
  return args.bus.subscribe((stored) => {
    void notifier.handle(stored.event);
  });
}
