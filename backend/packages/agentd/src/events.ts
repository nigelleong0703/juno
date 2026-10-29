/**
 * Event streaming via SSE.
 *
 * Lifecycle: subscribe to the live tail first, replay the durable backlog second, then flush any
 * events buffered in between. Subscribing before the backlog read closes the gap where an event
 * published during a slow read would otherwise be missed. A replayed event that also arrived live is
 * never sent twice. Live events are NOT filtered by a high-water id: ids are assigned at INSERT but
 * become visible at commit, so a transaction that inserted id 15 can commit after one that inserted
 * id 17, and dropping "older" ids would lose the late event for good.
 */

import type { Context } from 'hono';
import { toPublicRequest } from '@agent-desktop/contracts';
import type { EventBus, Store, StoredEvent } from '@agent-desktop/contracts';
import { EventType, normalizeStoredAgentEvent, type AgentEvent, type Item, type Message } from '@agent-desktop/public-contracts';
import { createLogger } from '@agent-desktop/log';
import { isConversationVisible } from './routes/relationships.js';

const log = createLogger({ service: 'agentd' });

const encoder = new TextEncoder();
const BACKLOG_PAGE = 100;
const HEARTBEAT_MS = 15000;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

/** Connect-time AG-UI synthesis for one conversation (docs/architecture/AGUI-MIGRATION.md). */
export interface AguiSnapshots {
  /** The authoritative messages of one conversation, as a synthesized MESSAGES_SNAPSHOT event. */
  forConversation(conversationId: string): Promise<AgentEvent[]>;
  /**
   * Conversations a reconnect restores: `active` are runs still executing (never dropped by the
   * bound), `recent` is the bounded ordinary history head.
   */
  conversationsForOwner(ownerId: string): Promise<{ active: string[]; recent: string[] }>;
  /** Whether this owner may see the conversation (a live preview is never synthesized across owners). */
  visible(conversationId: string, ownerId: string): Promise<boolean>;
}

/** Snapshots are bounded: reconnect restores the newest conversations, full history stays on the REST items page. */
const SNAPSHOT_CONVERSATIONS = 20;
const SNAPSHOT_ITEMS = 200;

/**
 * One item as a standard message: chat turns keep their roles, everything else is an
 * `activity` message so ordering and identity survive a snapshot without inventing prose.
 */
function snapshotMessage(item: Item, conversationId: string): Message | undefined {
  // Every message carries the COMPLETE public item (and its attribution) in the open metadata
  // object. Clients rebuild roles, cards, artifacts and the rest from the same object as REST,
  // instead of ignoring a snapshot whose text projection loses fields.
  const metadata = {
    juno: {
      conversationId,
      item,
      at: item.at,
      ...(item.type === 'user_message' ? { authorId: item.authorId } : {}),
      ...('agentId' in item && item.agentId !== undefined ? { agentId: item.agentId } : {}),
      ...('runId' in item && item.runId !== undefined ? { runId: item.runId } : {}),
    },
  };
  if (item.type === 'user_message') return { id: item.id, role: 'user', content: item.text, metadata };
  if (item.type === 'agent_message') return { id: item.id, role: 'assistant', content: item.markdown, metadata };
  if (item.type === 'request') {
    return { id: item.id, role: 'activity', activityType: 'juno.request', content: { requestId: item.requestId }, metadata };
  }
  if (item.type === 'artifact') {
    return { id: item.id, role: 'activity', activityType: 'juno.artifact', content: { artifactId: item.artifactId, version: item.version }, metadata };
  }
  return { id: item.id, role: 'activity', activityType: 'juno.item', content: { itemType: item.type, conversationId, at: item.at }, metadata };
}

/** Connect-time snapshots built from the authoritative persisted items (never stored events). */
export function aguiSnapshots(store: Store): AguiSnapshots {
  const visibleOf = async (conversationId: string, ownerId: string): Promise<boolean> => {
    const conversation = await store.get('conversations', conversationId);
    return conversation !== null && isConversationVisible(conversation, ownerId);
  };
  return {
    async forConversation(conversationId: string): Promise<AgentEvent[]> {
      // Newest first, then chronological: a long chat restores its latest window, never its oldest 200.
      const page = await store.list('items', { where: { conversationId }, orderBy: 'at', order: 'desc', limit: SNAPSHOT_ITEMS });
      const messages = [...page.items]
        .reverse()
        .map((item) => snapshotMessage(item, conversationId))
        .filter((message): message is Message => message !== undefined);
      // MESSAGES_SNAPSHOT is conversation-wide and carries no threadId: Juno attribution makes it
      // unambiguous when a reconnect restores several conversations.
      return [{ type: EventType.MESSAGES_SNAPSHOT, messages, metadata: { juno: { conversationId } } }];
    },
    visible: visibleOf,
    async conversationsForOwner(ownerId: string): Promise<{ active: string[]; recent: string[] }> {
      // A run still executing (including one parked on an approval) is always restored, whatever its
      // conversation's age. The store is owner-scoped at the route, and the visibility check keeps a
      // raw/test store honest as well.
      const active: string[] = [];
      for (const status of ['running', 'waiting_for_input'] as const) {
        const page = await store.list('runs', { where: { status }, orderBy: 'at', order: 'desc', limit: 100 });
        for (const run of page.items) {
          const conversationId = run.conversationId;
          if (conversationId === undefined || active.includes(conversationId)) continue;
          if (await visibleOf(conversationId, ownerId)) active.push(conversationId);
        }
      }
      // Ordinary history: owner-scoped pages, never a global head sliced before filtering. Page
      // through only until the bounded head is full.
      const recent: string[] = [];
      let cursor: string | undefined;
      for (let pageIndex = 0; pageIndex < 10 && recent.length < SNAPSHOT_CONVERSATIONS; pageIndex += 1) {
        const page = await store.list('conversations', {
          orderBy: 'at',
          order: 'desc',
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const conversation of page.items) {
          if (!isConversationVisible(conversation, ownerId) || active.includes(conversation.id) || recent.includes(conversation.id)) continue;
          recent.push(conversation.id);
          if (recent.length >= SNAPSHOT_CONVERSATIONS) break;
        }
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
      return { active, recent };
    },
  };
}

/** The conversation an event belongs to, from its explicit field or its Juno metadata. */
function conversationIdOf(event: AgentEvent): string | undefined {
  const direct = (event as { conversationId?: unknown }).conversationId;
  if (typeof direct === 'string') return direct;
  const threadId = (event as { threadId?: unknown }).threadId;
  if (typeof threadId === 'string') return threadId;
  const metadata = (event as { metadata?: unknown }).metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const juno = (metadata as { juno?: unknown }).juno;
  if (typeof juno !== 'object' || juno === null) return undefined;
  const junoConversation = (juno as { conversationId?: unknown }).conversationId;
  return typeof junoConversation === 'string' ? junoConversation : undefined;
}

/**
 * Streams events as SSE. Resumes from `?after=` or the Last-Event-ID header, sends `reset` only when
 * the client's cursor fell behind the retained log (an actual gap), and keeps a 15s heartbeat.
 */
export async function streamEvents(
  c: Context,
  eventBus: EventBus,
  onClose?: () => void,
  snapshots?: AguiSnapshots,
  ownerId?: string,
): Promise<Response> {
  const after = resolveCursor(c);

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  const touched = new Set<string>();

  // Cancellation owns listener + heartbeat cleanup. It is also reached from start() when the request
  // is aborted while the async subscribe is still in flight.
  const release = async (): Promise<void> => {
    if (!closed) onClose?.();
    closed = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    const unsub = unsubscribe;
    unsubscribe = undefined;
    if (unsub) await unsub();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const replayed = new Set<number>();
      const pending: StoredEvent[] = [];
      let replaying = true;

      const enqueue = (chunk: string): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };

      const send = (event: StoredEvent): void => {
        if (event.id <= after || replayed.has(event.id)) return;
        // The production read boundary: stored rows are normalized to the current wire; legacy
        // chat frames and unknown types fail closed (dropped, never leaked).
        const normalized = normalizeStoredAgentEvent(event.event);
        if (normalized === null) return;
        touched.add(conversationIdOf(normalized) ?? '');
        enqueue(formatEvent({ ...event, event: normalized }));
      };

      const onLive = (event: StoredEvent): void => {
        if (closed) return;
        if (replaying) {
          pending.push(event);
          return;
        }
        send(event);
      };

      // The backlog is read in id order and never repeats an id; remember what it sent for the live overlap.
      const sendReplayed = (event: StoredEvent): void => {
        send(event);
        replayed.add(event.id);
      };

      try {
        const unsub = await eventBus.subscribe(onLive);
        unsubscribe = unsub;
        if (closed) {
          await unsub();
          unsubscribe = undefined;
          return;
        }

        if (await hasRetainedGap(eventBus, after)) {
          enqueue('event: reset\n\n');
        }

        await replayBacklog(eventBus, after, sendReplayed);



        // Connect-time synthesis: the standard client rebuilds conversation state from
        // MESSAGES_SNAPSHOT (there is no token preview to restore: replies stream as closed paragraph
        // bubbles, which are durable events and replay like any other). Even a
        // reconnect at the head (no backlog) still gets the currently authorized conversations.
        const selected = new Set<string>();
        for (const id of touched) {
          if (id === '') continue;
          if (selected.size >= SNAPSHOT_CONVERSATIONS) break;
          selected.add(id);
        }
        if (snapshots !== undefined && ownerId !== undefined) {
          const head = await snapshots.conversationsForOwner(ownerId);
          // Executing runs are never dropped by the bounded history head.
          for (const id of head.active) selected.add(id);
          for (const id of head.recent) {
            if (selected.size >= SNAPSHOT_CONVERSATIONS) break;
            selected.add(id);
          }
        }
        for (const conversationId of selected) {
          if (snapshots !== undefined) {
            for (const snapshot of await snapshots.forConversation(conversationId)) {
              // Synthesized frames are not log rows: no id line, so a client's row-id dedupe and
              // Last-Event-ID cursor stay on the last durable row.
              enqueue(formatTransientEvent(snapshot));
            }
          }
        }

        replaying = false;
        for (const event of pending.sort((a, b) => a.id - b.id)) send(event);
        pending.length = 0;

        if (closed) return;
        heartbeat = setInterval(() => enqueue(': heartbeat\n\n'), HEARTBEAT_MS);
      } catch (error) {
        log.error({ err: error }, 'SSE stream error');
        if (!closed) controller.error(error);
        await release();
      }
    },
    async cancel() {
      await release();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * How far below the visible head the starting cursor sits. An id is assigned at INSERT and only becomes
 * visible at commit, so a lower id can still commit after the head was read; the margin keeps such a late
 * event inside the replay window. Replay is idempotent for clients, so the extra ids cost only bandwidth.
 */
export const CURSOR_MARGIN = 200;

/**
 * Safe starting cursor for a client that is about to load its REST snapshot: replay from here, then open
 * the stream. Never below `earliest - 1` for this owner: the event ids are global, so an owner whose whole
 * history sits in the last CURSOR_MARGIN ids would otherwise look like a retained-log gap and get `reset`.
 */
export async function eventCursor(eventBus: EventBus): Promise<number> {
  if (typeof eventBus.head !== 'function') throw new Error('EventBus.head is required for the events cursor');
  const head = await eventBus.head();
  const margin = Math.max(0, head - CURSOR_MARGIN);
  const earliest = (await eventBus.since(0, 1))[0];
  return earliest !== undefined ? Math.max(margin, earliest.id - 1) : margin;
}

/** `?after=` wins over Last-Event-ID; anything non-numeric or <= 0 means "from the start". */
function resolveCursor(c: Context): number {
  const raw = c.req.query('after') ?? c.req.header('Last-Event-ID') ?? '0';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Compare against the oldest retained event, not the next event after the cursor:
 * Postgres sequences can contain gaps from rolled-back transactions.
 */
async function hasRetainedGap(eventBus: EventBus, after: number): Promise<boolean> {
  if (after <= 0) return false;
  const earliest = await eventBus.since(0, 1);
  const first = earliest[0];
  return first !== undefined && first.id > after + 1;
}

/** Reads the durable log in pages so a backlog larger than one page is fully replayed. */
async function replayBacklog(
  eventBus: EventBus,
  after: number,
  onEvent: (event: StoredEvent) => void
): Promise<void> {
  let cursor = after;
  for (;;) {
    const page = await eventBus.since(cursor, BACKLOG_PAGE);
    for (const event of page) onEvent(event);
    const last = page[page.length - 1];
    if (page.length < BACKLOG_PAGE || last === undefined) return;
    cursor = last.id;
  }
}

/**
 * Last line of defence for the client-visible stream: a request event carries the public request only.
 * Emitters already strip, but the durable log may hold older events written before they did.
 */
function publicEvent(event: AgentEvent): AgentEvent {
  if (event.type === 'request.created' || event.type === 'request.resolved') {
    return { ...event, request: toPublicRequest(event.request) };
  }
  return event;
}

function formatEvent(event: StoredEvent): string {
  const name = event.event.type.includes('delta') ? 'delta' : event.event.type;
  return `id: ${event.id}\nevent: ${name}\ndata: ${JSON.stringify(publicEvent(event.event))}\n\n`;
}

/**
 * A synthesized (never stored) frame. It deliberately has no `id:` line: browsers keep the last
 * durable Last-Event-ID, and clients that dedupe by row id cannot drop two snapshots that reused a
 * cursor value (the old bug when several snapshots shared the backlog head).
 */
function formatTransientEvent(event: AgentEvent): string {
  const name = event.type.includes('delta') ? 'delta' : event.type;
  return `event: ${name}\ndata: ${JSON.stringify(publicEvent(event))}\n\n`;
}
