/**
 * Starts the outbox (BACKEND 5.7.11) in the coordinator: the sender, the start-up catch-up, the periodic scan and the bus subscription that only makes
 * rows sooner. Everything that must leave the platform is a row here; this is the one place that decides a row should exist.
 */
import type { Enqueuer, Store } from '@agent-desktop/contracts';
import type { BlobStore } from '@agent-desktop/contracts';
import type { AgentEvent } from '@agent-desktop/public-contracts';
import { createLogger } from '@agent-desktop/log';
import type { ChannelSenders } from '../channels/delivery.js';
import { planRunOutputs } from '../channels/outputs.js';
import type { ChannelRegistry } from '../channels/registry.js';
import { finishWorking } from '../channels/working.js';
import { createPushNotifier, createPushSenders, type PushNotifier } from '../push/notifier.js';
import { channelMetaOf } from '../routes/channels.js';
import { createSeen, ingestItem, ingestRequest, scanItems, scanRequests } from './intake.js';
import { startOutboxSender, type OutboxSender } from './sender.js';

const log = createLogger({ service: 'agentd' });

/** A restart looks back this far for deliveries whose row was never made; a push only a few minutes (an old notification is noise). */
const CATCH_UP_MS = 24 * 60 * 60_000;
const PUSH_CATCH_UP_MS = 15 * 60_000;
/** The periodic scan looks at items this recent: a streamed bubble is released up to a model turn after it was written. */
const SCAN_WINDOW_MS = 10 * 60_000;
const SCAN_EVERY_MS = 5_000;

export interface OutboxDeps {
  store: Store;
  bus: { subscribe(onEvent: (stored: { event: AgentEvent }) => void): Promise<() => void> };
  senders: ChannelSenders;
  channels: ChannelRegistry;
  blobs: BlobStore;
  channelFetch?: typeof fetch;
  enqueuer: Enqueuer;
  env: NodeJS.ProcessEnv;
}

export interface RunningOutbox {
  sender: OutboxSender;
  stop(): void;
}

function junoMetadataOf(event: AgentEvent): Record<string, unknown> {
  const metadata = (event as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return {};
  const juno = (metadata as { juno?: unknown }).juno;
  return typeof juno === 'object' && juno !== null ? (juno as Record<string, unknown>) : {};
}

const ownerOfConversation = async (store: Store, conversationId: string): Promise<string | undefined> => {
  const owner = ((await store.get('conversations', conversationId).catch(() => null)) as { ownerId?: unknown } | null)?.ownerId;
  return typeof owner === 'string' ? owner : undefined;
};

/** The documents of finished runs of the last day, queued behind their answers (a run's RUN_FINISHED lost to a restart). */
async function scanOutputs(store: Store, sinceMs: number): Promise<void> {
  const channelConversations = new Map<string, string | undefined>();
  for (const run of (await store.list('runs', { where: { status: 'completed' }, orderBy: 'at', order: 'desc', limit: 300 })).items) {
    if (run.parentRunId !== undefined || run.conversationId === undefined || run.finishedAt === undefined || Date.parse(run.finishedAt) < sinceMs) continue;
    if (!channelConversations.has(run.conversationId)) {
      const conv = await store.get('conversations', run.conversationId);
      channelConversations.set(run.conversationId, conv !== null && channelMetaOf(conv) !== undefined ? (conv as { ownerId?: string }).ownerId : undefined);
    }
    const owner = channelConversations.get(run.conversationId);
    if (owner !== undefined) await planRunOutputs({ store }, owner, { id: run.id, agentId: run.agentId, conversationId: run.conversationId });
  }
}

export async function startOutbox(deps: OutboxDeps): Promise<RunningOutbox> {
  const { store } = deps;
  const pushSenders = createPushSenders(deps.env);
  const push: PushNotifier | undefined = pushSenders === undefined ? undefined : createPushNotifier({ store, senders: pushSenders });
  const sender = startOutboxSender({
    store, senders: deps.senders, channels: deps.channels, blobs: deps.blobs, enqueuer: deps.enqueuer, env: deps.env,
    ...(pushSenders === undefined ? {} : { push: pushSenders }), ...(deps.channelFetch === undefined ? {} : { channelFetch: deps.channelFetch }),
  });
  const seen = createSeen();

  // Start-up catch-up: whatever was stored but never got its row (the process died between the two) gets it now.
  const startedAt = Date.now();
  try {
    const items = await scanItems(store, startedAt - CATCH_UP_MS, seen);
    const cards = await scanRequests(store, startedAt - CATCH_UP_MS, deps.senders);
    await scanOutputs(store, startedAt - CATCH_UP_MS);
    const pushes = push === undefined ? 0 : await push.catchUp(startedAt - PUSH_CATCH_UP_MS);
    log.info({ items, cards, pushes }, 'outbox catch-up');
  } catch (err) {
    log.warn({ err }, 'outbox catch-up failed; the periodic scan will retry');
  }
  sender.wake();

  const scan = setInterval(() => {
    scanItems(store, Date.now() - SCAN_WINDOW_MS, seen).then((made) => { if (made > 0) sender.wake(); }).catch((err: unknown) => log.warn({ err }, 'outbox scan failed'));
  }, SCAN_EVERY_MS);
  scan.unref();

  // The bus is only a wake-up: it makes the row of a new item, question or finished run at once instead of at the next scan.
  const handle = async (event: AgentEvent): Promise<void> => {
    if (event.type === 'item.added' && event.item.type === 'agent_message') {
      await ingestItem(store, event.item);
    } else if (event.type === 'request.created' && event.request.conversationId !== undefined) {
      await ingestRequest(store, event.request.id, deps.senders);
    } else if (event.type === 'artifact.updated') {
      // A document got its content after the run that proposed it was over (the owner approved the draft later): it follows into the thread now.
      const { runId, conversationId, createdByAgentId } = event.artifact;
      if (runId !== undefined && conversationId !== undefined && createdByAgentId !== undefined) {
        const owner = await ownerOfConversation(store, conversationId);
        const run = owner === undefined ? null : await store.forOwner?.(owner).get('runs', runId).catch(() => null);
        if (owner !== undefined && run !== null && run !== undefined && ['completed', 'failed', 'stopped'].includes(run.status)) await planRunOutputs({ store }, owner, { id: runId, agentId: createdByAgentId, conversationId });
      }
    } else if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') {
      // The run is over, whatever the outcome (a failed run closes with RUN_ERROR): the "working" reaction comes off the message that started it.
      const juno = junoMetadataOf(event);
      const conversationId = juno['conversationId'];
      if (typeof conversationId === 'string') void finishWorking(conversationId);
      const run = juno['run'];
      const record: Record<string, unknown> = typeof run === 'object' && run !== null ? (run as Record<string, unknown>) : {};
      // A finished root run that answered in a group: the documents it made follow its answer into the thread.
      if (event.type === 'RUN_FINISHED' && typeof conversationId === 'string' && typeof record['id'] === 'string' && typeof record['agentId'] === 'string' && record['parentRunId'] === undefined) {
        const owner = await ownerOfConversation(store, conversationId);
        if (owner !== undefined) await planRunOutputs({ store }, owner, { id: record['id'], agentId: record['agentId'], conversationId });
      }
    }
    if (push !== undefined) await push.handle(event);
  };
  const unsubscribe = await deps.bus.subscribe(({ event }) => {
    handle(event).then(() => { sender.wake(); }).catch((err: unknown) => log.warn({ err, eventType: event.type }, 'outbox intake failed'));
  });

  return {
    sender,
    stop() {
      clearInterval(scan);
      unsubscribe();
      sender.stop();
    },
  };
}
