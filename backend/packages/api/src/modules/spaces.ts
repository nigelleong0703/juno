/** Spaces on the API side (BACKEND 5.12): published apps of one owner, their live status, and where their computer's gateway is (via computerd). */
import type { Store } from '@agent-desktop/contracts';
import type { SpaceHostedRecord, SpaceRecord } from '@agent-desktop/contracts';
import type { Space, SpaceHosted, SpaceStatus } from '@agent-desktop/public-contracts';

export interface ComputerdLink {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

/** One POST to computerd for the owner; the answer is its JSON object (throws on any other answer). */
export async function computerd(link: ComputerdLink, ownerId: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await (link.fetch ?? fetch)(new URL(path, link.url), {
    method: 'POST',
    headers: { authorization: `Bearer ${link.token}`, 'x-owner-id': ownerId, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const parsed: unknown = await response.json().catch(() => undefined);
  if (!response.ok || typeof parsed !== 'object' || parsed === null) throw new Error(`computerd ${path} answered ${response.status}`);
  return parsed as Record<string, unknown>;
}

export interface GatewayAddress {
  /** computerd's gateway proxy (the computer publishes no port, BACKEND §7.11); always ends in `/`. A request to `<url><path>` reaches the gateway at `/<path>`. */
  url: string;
  /** Sent as `X-Juno-Gateway-Key` on every request to the gateway. */
  key: string;
  /** The platform's credentials for computerd's proxy; computerd removes them before the request reaches the computer. */
  headers: Record<string, string>;
}

/** How to reach the owner's computer-side gateway (through computerd), and its key. Resumes a paused computer; the answer is reused for a few seconds, `fresh` skips that. */
export function createGatewayResolver(link: ComputerdLink): (ownerId: string, fresh?: boolean) => Promise<GatewayAddress> {
  const cache = new Map<string, GatewayAddress & { at: number }>();
  return async (ownerId, fresh = false) => {
    const hit = cache.get(ownerId);
    if (!fresh && hit !== undefined && Date.now() - hit.at < 5_000) return hit;
    const { key } = await computerd(link, ownerId, '/v1/spaces/gateway', {});
    if (typeof key !== 'string') throw new Error('computerd returned no gateway key');
    const address: GatewayAddress = { url: new URL('/v1/spaces/gateway-proxy/', link.url).toString(), key, headers: { 'x-juno-computerd-token': link.token, 'x-juno-owner': ownerId } };
    cache.set(ownerId, { ...address, at: Date.now() });
    return address;
  };
}

/** Status of each published app: unknown when computerd does not answer, otherwise paused / running / not listening. */
export async function spaceStatuses(link: ComputerdLink | undefined, ownerId: string, rows: readonly SpaceRecord[]): Promise<Map<string, SpaceStatus>> {
  const statuses = new Map<string, SpaceStatus>(rows.map((row) => [row.id, 'unknown']));
  if (link === undefined || rows.length === 0) return statuses;
  try {
    const answer = await computerd(link, ownerId, '/v1/spaces/status', { spaces: rows.map((row) => row.id) });
    const listening = new Set(Array.isArray(answer['listening']) ? answer['listening'] : []);
    for (const row of rows) {
      if (answer['computer'] === 'paused') statuses.set(row.id, 'computer_paused');
      else if (answer['computer'] === 'running') statuses.set(row.id, listening.has(row.id) ? 'running' : 'not_listening');
    }
  } catch {
    // The statuses stay unknown.
  }
  return statuses;
}

/** The share link of a hosted Space, when it has one that is not revoked. */
export function toHosted(record: SpaceHostedRecord): SpaceHosted {
  return { spaceId: record.id, url: record.url, visibility: record.visibility, visitorWrites: record.visitorWrites === true, version: record.version, publishedAt: record.publishedAt, updatedAt: record.updatedAt };
}

export function toSpace(row: SpaceRecord, status: SpaceStatus, hosted?: SpaceHostedRecord | null): Space {
  const share = hosted && !hosted.revokedAt ? { hosted: toHosted(hosted) } : {};
  return { id: row.id, title: row.title, slug: row.slug, agentId: row.agentId, artifactId: row.artifactId ?? '', status, ...share, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** The owner's published apps, newest first (allocated-but-unpublished rows are not apps yet). */
export async function publishedSpaces(scoped: Store): Promise<SpaceRecord[]> {
  const rows: SpaceRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await scoped.list('spaces', { where: { status: 'published' }, limit: 200, orderBy: 'at', order: 'desc', ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  return rows;
}

export async function publishedSpace(scoped: Store, id: string): Promise<SpaceRecord | null> {
  const row = await scoped.get('spaces', id);
  return row !== null && row.status === 'published' && row.artifactId !== undefined ? row : null;
}
