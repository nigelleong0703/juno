/**
 * Where the user is right now, for the agent's context: which app they have open (the live event
 * stream they hold, tagged by the client with `x-juno-client`), whether they are watching this
 * agent's screen (the screen stream the gateway proxies), and when they were last active.
 *
 * The coordinator holds the streams, so it is the only writer: it counts them in memory and writes the owner's row
 * (`ownerPresence`) whenever they change and every few seconds while any is open. Execution workers build the agent's
 * context and run the `phone_*` tools in other processes, so everything is read from that row (BACKEND 2.2c). A row that
 * claims open apps but whose heartbeat is older than the TTL belongs to a coordinator that died: it reads as "no app
 * open", never as a stream that is still there.
 */
import type { PhoneDeclaration } from '@agent-desktop/public-contracts';
import type { ClientKind, OwnerPresenceRow, Store } from '../contracts/index.js';

export type { ClientKind };

/** How often the coordinator rewrites the rows of owners with an open stream, and how old a heartbeat may be. */
export const PRESENCE_HEARTBEAT_MS = 10_000;
export const PRESENCE_TTL_MS = 30_000;

const CLIENT_NAMES: Record<ClientKind, string> = { ios: 'the iPhone app', android: 'the Android app', web: 'the web app', desktop: 'the desktop app' };

interface OwnerLive {
  /** Open event streams per client kind (a client may hold more than one, e.g. two tabs). */
  streams: Map<ClientKind, number>;
  /** Open screen streams per agent. */
  watching: Map<string, number>;
  /** When the last stream closed; only meaningful while none is open. */
  lastActiveAt?: number;
  phone?: PhoneDeclaration;
}

/** This process's connections: only the coordinator (or the single `all` process) ever has any. */
const owners = new Map<string, OwnerLive>();
/** Writes of one owner's row run one after another, each writing the state as it is when it runs. */
const writes = new Map<string, Promise<void>>();

function ownerLive(ownerId: string): OwnerLive {
  let live = owners.get(ownerId);
  if (!live) {
    live = { streams: new Map(), watching: new Map() };
    owners.set(ownerId, live);
  }
  return live;
}

function bump<K>(counts: Map<K, number>, key: K, by: 1 | -1): void {
  const next = (counts.get(key) ?? 0) + by;
  if (next > 0) counts.set(key, next);
  else counts.delete(key);
}

function rowOf(ownerId: string, live: OwnerLive, now: number): OwnerPresenceRow {
  return {
    id: ownerId,
    ownerId,
    clients: [...live.streams.keys()],
    watching: [...live.watching.keys()],
    ...(live.lastActiveAt === undefined ? {} : { lastActiveAt: live.lastActiveAt }),
    heartbeatAt: now,
    ...(live.phone === undefined ? {} : { phone: live.phone }),
  };
}

function persist(store: Store, ownerId: string): Promise<void> {
  const previous = writes.get(ownerId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const live = owners.get(ownerId);
      if (live !== undefined) await store.put('ownerPresence', rowOf(ownerId, live, Date.now()));
    });
  writes.set(ownerId, next);
  const clear = (): void => { if (writes.get(ownerId) === next) writes.delete(ownerId); };
  next.then(clear, clear);
  return next;
}

/** The client kind from the `x-juno-client` header; anything else is not counted as an app. */
export function clientKind(value: string | undefined): ClientKind | undefined {
  return value === 'ios' || value === 'android' || value === 'web' || value === 'desktop' ? value : undefined;
}

/** An app opened its live event stream; call the returned function once when it closes. */
export async function connectClient(store: Store, ownerId: string, client: ClientKind, now: () => number = Date.now): Promise<() => Promise<void>> {
  const live = ownerLive(ownerId);
  bump(live.streams, client, 1);
  await persist(store, ownerId);
  let open = true;
  return async () => {
    if (!open) return;
    open = false;
    bump(live.streams, client, -1);
    live.lastActiveAt = now();
    // The iPhone's declaration lives only while its stream does.
    if (client === 'ios' && !live.streams.has('ios')) delete live.phone;
    await persist(store, ownerId);
  };
}

/** The user started (true) or stopped (false) watching an agent's screen. */
export async function watchScreen(store: Store, ownerId: string, agentId: string, watching: boolean): Promise<void> {
  bump(ownerLive(ownerId).watching, agentId, watching ? 1 : -1);
  await persist(store, ownerId);
}

/** The iPhone app declared what it can do, or (undefined) withdrew it; written with the rest of the owner's row. */
export async function setPhoneDeclaration(store: Store, ownerId: string, declaration: PhoneDeclaration | undefined, deviceId?: string): Promise<void> {
  const live = ownerLive(ownerId);
  if (declaration === undefined) {
    if (live.phone === undefined || (deviceId !== undefined && live.phone.deviceId !== deviceId)) return;
    delete live.phone;
  } else {
    live.phone = declaration;
  }
  await persist(store, ownerId);
}

function asDead(row: OwnerPresenceRow): OwnerPresenceRow {
  return { id: row.id, ownerId: row.ownerId, clients: [], watching: [], lastActiveAt: row.heartbeatAt, heartbeatAt: row.heartbeatAt };
}

/** The owner's row as a worker should believe it: a stale heartbeat means the coordinator is gone, so no stream is open. */
export async function readPresence(store: Store, ownerId: string | undefined, now: number = Date.now()): Promise<OwnerPresenceRow | undefined> {
  if (ownerId === undefined) return undefined;
  const row = await store.get('ownerPresence', ownerId);
  if (row === null) return undefined;
  return row.clients.length === 0 || now - row.heartbeatAt <= PRESENCE_TTL_MS ? row : asDead(row);
}

/** Whether this owner has an event stream open from this kind of app right now. */
export async function clientOpen(store: Store, ownerId: string, client: ClientKind): Promise<boolean> {
  return (await readPresence(store, ownerId))?.clients.includes(client) === true;
}

function ago(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** One line for the agent's context; '' while unknown (no app seen yet). */
export async function presenceLine(store: Store, ownerId: string | undefined, agentId: string, now: number = Date.now()): Promise<string> {
  const presence = await readPresence(store, ownerId, now);
  if (!presence) return '';
  if (presence.clients.length > 0) {
    const apps = presence.clients.map((kind) => CLIENT_NAMES[kind]);
    const watching = presence.watching.includes(agentId) ? ' and is watching your screen' : '';
    return `The user has ${apps.join(' and ')} open right now${watching}.`;
  }
  if (presence.lastActiveAt === undefined) return '';
  return `The user is not in the app (last active ${ago(now - presence.lastActiveAt)}).`;
}

/**
 * The coordinator's loop: keep the rows of owners with an open stream fresh (a worker would otherwise read them as dead after the
 * TTL). Returns the stop function.
 */
export function startPresenceHeartbeat(store: Store, intervalMs: number = PRESENCE_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    for (const [ownerId, live] of owners) {
      if (live.streams.size > 0) persist(store, ownerId).catch(() => undefined);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * A new coordinator starts with no connections, so whatever the previous one wrote about open apps is wrong; clients reconnect
 * and rewrite their rows within seconds. Rows with nothing open keep their `lastActiveAt`.
 */
export async function forgetPresence(store: Store): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.list('ownerPresence', { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    for (const row of page.items) {
      if (row.clients.length > 0 || row.phone !== undefined) await store.put('ownerPresence', asDead(row));
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

/** Test seam: forget this process's connections. */
export function resetPresence(): void {
  owners.clear();
  writes.clear();
}
