/**
 * Hosted Spaces on the API side (BACKEND 5.12, option B): publish a published app to long-lived hosting, change who may open it
 * and whether visitors may change its data, revoke it. The pages and rows are read from the app's computer (computerd), written
 * by the publisher of services/spaces-host, and the share link is kept here as a `spaceHosted` row (metadata only).
 */
import type { SpaceHostedRecord, SpaceRecord, Store } from '@agent-desktop/contracts';
import { HostedError, createHostedPublisher, type Access, type HostedSpacesPublisher } from '@agent-desktop/spaces-host/publisher';
import { cloudflareStorage } from '@agent-desktop/spaces-host/cloudflare-storage';
import { devStorage } from '@agent-desktop/spaces-host/local-storage';
import { hostableSnapshot, spaceSnapshotSchema, type HostedRow, type SnapshotFile } from '@agent-desktop/spaces-host/snapshot';
import type { ApiConfig } from '../config.js';
import { computerd, type ComputerdLink } from './spaces.js';

/** The hosted copy's ways out to the world: the publisher, and the Space's pages and rows from its computer. */
export interface HostedDeps {
  publisher: HostedSpacesPublisher;
  /** Reads the Space from its computer; throws a `server_code` HostedError when the Space runs its own server code. */
  snapshot(ownerId: string, slug: string): Promise<{ files: SnapshotFile[]; tables: Record<string, HostedRow[]> }>;
}

/** Hosting is on (with its deps) or off (with what is missing, for the 503 answer). */
export type HostedSetup = { ready: true; deps: HostedDeps } | { ready: false; reason: string };

const REQUIRED = ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'SPACES_CONTENT_DOMAIN', 'SPACES_HOST_D1_DATABASE_ID', 'SPACES_HOST_R2_BUCKET', 'SPACES_HOST_SIGNING_KEY'] as const;
const LOCAL_REQUIRED = ['SPACES_CONTENT_DOMAIN', 'SPACES_HOST_SIGNING_KEY', 'SPACES_HOST_LOCAL_ADMIN_TOKEN'] as const;

/** Hosting from the configuration: Cloudflare when `SPACES_HOST_LOCAL_URL` is empty, a local `wrangler dev` otherwise (development). */
export function hostedSetup(config: ApiConfig, computerdLink: ComputerdLink): HostedSetup {
  const local = config.SPACES_HOST_LOCAL_URL !== '';
  const missing = (local ? LOCAL_REQUIRED : REQUIRED).filter((name) => config[name] === '');
  if (missing.length > 0) return { ready: false, reason: `hosted Spaces are not configured on this server: set ${missing.join(', ')}` };
  const storage = local
    ? devStorage({ baseUrl: config.SPACES_HOST_LOCAL_URL, adminToken: config.SPACES_HOST_LOCAL_ADMIN_TOKEN })
    : cloudflareStorage({ accountId: config.CF_ACCOUNT_ID, apiToken: config.CF_API_TOKEN, databaseId: config.SPACES_HOST_D1_DATABASE_ID, bucket: config.SPACES_HOST_R2_BUCKET });
  const publisher = createHostedPublisher({ storage, signingKey: config.SPACES_HOST_SIGNING_KEY, contentScheme: config.SPACES_CONTENT_SCHEME, contentDomain: config.SPACES_CONTENT_DOMAIN });
  return {
    ready: true,
    deps: {
      publisher,
      snapshot: async (ownerId, slug) => hostableSnapshot(spaceSnapshotSchema.parse(await computerd(computerdLink, ownerId, '/v1/spaces/snapshot', { slug }))),
    },
  };
}

/** The live share link of a Space (revoked ones are kept as rows, but are not live). */
export async function liveHosted(scoped: Store, spaceId: string): Promise<SpaceHostedRecord | null> {
  const record = await scoped.get('spaceHosted', spaceId);
  return record === null || record.revokedAt !== undefined ? null : record;
}

const nowIso = (): string => new Date().toISOString();

/** The hosted operations of one Space run one at a time in this process: a double click must not make two links. */
const queues = new Map<string, Promise<unknown>>();
function oneAtATime<T>(spaceId: string, run: () => Promise<T>): Promise<T> {
  const next = (queues.get(spaceId) ?? Promise.resolve()).catch(() => undefined).then(run);
  queues.set(spaceId, next);
  void next.then(
    () => (queues.get(spaceId) === next ? queues.delete(spaceId) : undefined),
    () => (queues.get(spaceId) === next ? queues.delete(spaceId) : undefined),
  );
  return next;
}

/**
 * Publish the app: its first publish (access defaults: visibility `link`, visitors read-only), or a new version at the same link
 * (the access stays unless `access` names a change).
 */
export function publishHosted(scoped: Store, deps: HostedDeps, ownerId: string, row: SpaceRecord, access: Access = {}): Promise<SpaceHostedRecord> {
  return oneAtATime(row.id, async () => {
    const live = await liveHosted(scoped, row.id);
    const snapshot = await deps.snapshot(ownerId, row.slug);
    const published = await deps.publisher.publish({ ...(live === null ? {} : { linkId: live.linkId }), slug: row.slug, ...access, files: snapshot.files, tables: snapshot.tables });
    const at = nowIso();
    const record: SpaceHostedRecord = {
      id: row.id,
      ownerId,
      agentId: row.agentId,
      linkId: published.linkId,
      url: published.url,
      visibility: published.visibility,
      visitorWrites: published.visitorWrites,
      version: published.version,
      publishedAt: live?.publishedAt ?? at,
      updatedAt: at,
    };
    await scoped.put('spaceHosted', record, { agentId: row.agentId, status: 'published', parentId: row.id });
    return record;
  });
}

/** Change who may open the hosted copy and/or whether visitors may change its data. Throws `not_found` when the Space has no live link. */
export function updateHosted(scoped: Store, deps: HostedDeps, spaceId: string, update: Access): Promise<SpaceHostedRecord> {
  return oneAtATime(spaceId, async () => {
    const live = await requireLive(scoped, spaceId);
    const access = await deps.publisher.setAccess(live.linkId, update);
    const record: SpaceHostedRecord = { ...live, visibility: access.visibility, visitorWrites: access.visitorWrites, updatedAt: nowIso() };
    await scoped.put('spaceHosted', record, { agentId: live.agentId, status: 'published', parentId: spaceId });
    return record;
  });
}

/** Revoke the share link: it answers 404 from now on and its data and pages are deleted. The row stays, marked revoked. */
export function revokeHosted(scoped: Store, deps: HostedDeps, spaceId: string): Promise<void> {
  return oneAtATime(spaceId, async () => {
    const live = await requireLive(scoped, spaceId);
    await deps.publisher.revoke(live.linkId);
    const at = nowIso();
    await scoped.put('spaceHosted', { ...live, revokedAt: at, updatedAt: at }, { agentId: live.agentId, status: 'revoked', parentId: spaceId });
  });
}

/** A sign-in link for the owner on the hosted copy (5 minutes to open it; the session cookie it sets lasts 12 hours). */
export async function hostedOpenUrl(scoped: Store, deps: HostedDeps, spaceId: string, ttlMs: number): Promise<{ url: string; expiresAt: string }> {
  const live = await requireLive(scoped, spaceId);
  const expiresAt = Date.now() + ttlMs;
  return { url: await deps.publisher.ownerOpenUrl(live.linkId, expiresAt), expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * Before the owner's account is deleted: revoke every live share link of the owner (their pages and data sit on the hosting
 * service, out of the private service's reach). Returns the reason to refuse the deletion, or undefined when nothing is left live.
 */
export async function revokeOwnerHosted(scoped: Store, hosted: HostedSetup | undefined): Promise<string | undefined> {
  const live: SpaceHostedRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await scoped.list('spaceHosted', { limit: 200, ...(cursor === undefined ? {} : { cursor }) });
    live.push(...result.items.filter((record) => record.revokedAt === undefined));
    cursor = result.nextCursor;
    if (cursor === undefined) break;
  }
  if (live.length === 0) return undefined;
  if (hosted === undefined) return 'hosted Spaces are not wired on this server';
  if (!hosted.ready) return hosted.reason;
  for (const record of live) {
    try {
      await revokeHosted(scoped, hosted.deps, record.id);
    } catch {
      return 'a hosted Space could not be revoked; try again';
    }
  }
  return undefined;
}

async function requireLive(scoped: Store, spaceId: string): Promise<SpaceHostedRecord> {
  const live = await liveHosted(scoped, spaceId);
  if (live === null) throw new HostedError('not_found', 'this Space has no live hosted link');
  return live;
}
