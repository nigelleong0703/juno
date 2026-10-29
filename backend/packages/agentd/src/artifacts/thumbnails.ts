/**
 * The thumbnail backfill (BACKEND 5.11): an HTML artifact version published before page screenshots existed gets one in the background.
 *
 * A pass looks only at owners whose computer is already running: a passive probe (computerd's status, which never resumes or starts
 * anything), so a paused computer is never woken for this. Each such owner gets at most BACKFILL_PER_OWNER versions per pass. The
 * screenshot is the same routine artifact_publish uses (`renderPageThumbnail`), run in the owner's computer as the artifact's agent.
 * Every version a pass tried gets a marker (`thumbnailTried` on the artifact row), whatever the outcome, so no version is tried twice.
 * A pass with nothing pending does no work at all. Spaces (render `app`) carry no version and are not covered.
 */
import type { DurableDb } from '@agent-desktop/durable';
import { artifactSchema, type ArtifactVersion } from '@agent-desktop/public-contracts';
import type { ComputerClient } from 'juno-agent/computer';
import { loadBlob, saveBlob, type ArtifactFile, type BlobStore, type LibraryDocument, type Store } from 'juno-agent/contracts';
import { renderPageThumbnail } from 'juno-agent/modules/tools/tools/artifactPreview';
import { shellQuote, type DecodedFile } from 'juno-agent/modules/tools/tools/sandboxFile';
import { newId, nowIso } from 'juno-agent/modules/tools/util';
import { runWithOwner } from '../owner-scope.js';
import type { ComputerdClient } from '../computerd.js';

export const BACKFILL_PER_OWNER = 20;
export const BACKFILL_INTERVAL_MS = 15 * 60_000;
const FIRST_PASS_DELAY_MS = 2 * 60_000;
const STATE_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 90_000;

export interface ThumbnailLog {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface ThumbnailCandidate {
  ownerId: string;
  doc: LibraryDocument;
}

export interface ThumbnailBackfillDeps {
  store: Store;
  blobs: BlobStore;
  /** The agents' computer client; absent when no sandbox backend is configured, which makes every pass a no-op. */
  computer: ComputerClient | undefined;
  computerd: Pick<ComputerdClient, 'computerState'>;
  /** Library rows that are HTML artifacts with at least one version (owner included). */
  candidates: () => Promise<ThumbnailCandidate[]>;
  log: ThumbnailLog;
}

export interface ThumbnailPassResult {
  pending: number;
  /** Owners whose computer was not running; their versions wait for a later pass. */
  ownersSkipped: number;
  attempted: number;
  stored: number;
}

/** The candidates from Postgres: one SQL read, the versions are filtered in code. Needs the raw database. */
export function rawThumbnailCandidates(db: DurableDb): () => Promise<ThumbnailCandidate[]> {
  return async () => {
    const rows = await db.query<{ owner_id: string; doc: LibraryDocument }>(
      "SELECT owner_id, doc FROM library WHERE doc->>'render' = 'html' AND jsonb_typeof(doc->'versions') = 'array'",
      [],
    );
    return rows.map((row) => ({ ownerId: row.owner_id, doc: row.doc }));
  };
}

/** The versions of one artifact that still need a thumbnail and were never tried. */
export function pendingVersions(doc: LibraryDocument): ArtifactVersion[] {
  const tried = new Set(doc.thumbnailTried ?? []);
  return (doc.versions ?? []).filter((version) => version.thumbnailRef === undefined && !tried.has(version.version));
}

/** One pass: group the pending versions by owner, then take the owners whose computer runs. Returns what it did. */
export async function runThumbnailPass(deps: ThumbnailBackfillDeps): Promise<ThumbnailPassResult> {
  const byOwner = new Map<string, Array<{ doc: LibraryDocument; version: ArtifactVersion }>>();
  let pending = 0;
  for (const candidate of await deps.candidates()) {
    for (const version of pendingVersions(candidate.doc)) {
      const list = byOwner.get(candidate.ownerId) ?? [];
      list.push({ doc: candidate.doc, version });
      byOwner.set(candidate.ownerId, list);
      pending += 1;
    }
  }
  const result: ThumbnailPassResult = { pending, ownersSkipped: 0, attempted: 0, stored: 0 };
  const client = deps.computer;
  // Nothing pending, or no computer to work with: no owner is probed and nothing is written.
  if (pending === 0 || client === undefined) return result;
  for (const [ownerId, versions] of byOwner) {
    const state = await runWithOwner(ownerId, () => deps.computerd.computerState(AbortSignal.timeout(STATE_TIMEOUT_MS))).catch(() => 'none' as const);
    if (state !== 'running') {
      result.ownersSkipped += 1;
      continue;
    }
    for (const item of versions.slice(0, BACKFILL_PER_OWNER)) {
      result.attempted += 1;
      const stored = await runWithOwner(ownerId, () => backfillVersion(deps, ownerId, item.doc, item.version, client))
        .catch((error: unknown) => {
          deps.log.warn({ err: error, artifactId: item.doc.id, version: item.version.version }, 'Thumbnail backfill failed for one version');
          return false;
        });
      if (stored) result.stored += 1;
    }
  }
  if (result.attempted > 0) deps.log.info({ ...result }, 'Thumbnail backfill pass');
  return result;
}

/** Screenshot one version in its agent's computer, then store the PNG and mark the version as tried (in one transaction). */
async function backfillVersion(deps: ThumbnailBackfillDeps, ownerId: string, doc: LibraryDocument, version: ArtifactVersion, client: ComputerClient): Promise<boolean> {
  const scoped = deps.store.forOwner?.(ownerId);
  if (scoped === undefined) return false;
  // A failed attempt is still an attempt: the version gets its marker below and is not tried again.
  const thumbnail = await screenshotVersion(deps, scoped, doc, version, client).catch((error: unknown) => {
    deps.log.warn({ err: error, artifactId: doc.id, version: version.version }, 'Thumbnail backfill: the screenshot failed');
    return undefined;
  });
  const at = nowIso();
  let row: ArtifactFile | undefined;
  if (thumbnail !== undefined) {
    const stored = await saveBlob(deps.blobs, thumbnail.bytes, 'image/png');
    const stem = (doc.sourcePath?.split('/').pop() ?? doc.name).replace(/\.[^.]+$/, '');
    row = { id: newId('af'), artifactId: doc.id, version: version.version, part: 'thumbnail', name: stem + '.png', mimeType: 'image/png', sizeBytes: stored.sizeBytes, sha256: stored.sha256, blobKey: stored.blobKey, createdAt: at };
  }
  return scoped.tx(async (tx) => {
    const current = await (tx.getForUpdate?.('library', doc.id) ?? tx.get('library', doc.id));
    if (current === null) return false;
    const tried = [...new Set([...(current.thumbnailTried ?? []), version.version])];
    const index = { conversationId: current.conversationId ?? null };
    const hit = row !== undefined && (current.versions ?? []).some((candidate) => candidate.version === version.version && candidate.thumbnailRef === undefined);
    if (!hit || row === undefined) {
      await tx.put('library', { ...current, thumbnailTried: tried }, index);
      return false;
    }
    await tx.put('artifactFiles', row, { parentId: doc.id, conversationId: current.conversationId ?? null });
    const next: LibraryDocument = {
      ...current,
      thumbnailTried: tried,
      versions: (current.versions ?? []).map((candidate) => (candidate.version === version.version ? { ...candidate, thumbnailRef: row?.id } : candidate)),
    };
    await tx.put('library', next, index);
    await tx.emit({ type: 'artifact.updated', artifact: artifactSchema.parse(next) });
    return true;
  });
}

/** The HTML bytes of the version go into a temporary file in the computer, the shared screenshot runs on it, and the file is removed. */
async function screenshotVersion(deps: ThumbnailBackfillDeps, scoped: Store, doc: LibraryDocument, version: ArtifactVersion, client: ComputerClient): Promise<DecodedFile | undefined> {
  const agentId = doc.createdByAgentId;
  if (agentId === undefined || version.fileRef === undefined) return undefined;
  const file = await scoped.get('artifactFiles', version.fileRef);
  if (file === null || file.blobKey === undefined) return undefined;
  const read = await loadBlob(deps.blobs, { blobKey: file.blobKey, sizeBytes: file.sizeBytes, ...(file.sha256 === undefined ? {} : { sha256: file.sha256 }) });
  if (!read.ok) {
    deps.log.warn({ artifactId: doc.id, version: version.version, reason: read.reason }, 'Thumbnail backfill: the page bytes are unavailable');
    return undefined;
  }
  const signal = AbortSignal.timeout(VERSION_TIMEOUT_MS);
  const htmlPath = '/tmp/juno-thumb-' + newId('th') + '.html';
  try {
    await client.writeFile(agentId, { path: htmlPath, content: read.bytes.toString('utf8') }, signal);
    const shot = await renderPageThumbnail({ computer: () => client }, { agentId, runId: 'thumbnail-backfill-' + doc.id, signal }, htmlPath);
    if (shot.note !== undefined) deps.log.info({ artifactId: doc.id, version: version.version, note: shot.note }, 'Thumbnail backfill: no thumbnail');
    return shot.thumbnail;
  } finally {
    await client.runShell(agentId, { command: 'rm -f ' + shellQuote(htmlPath), timeoutMs: STATE_TIMEOUT_MS }, signal).catch(() => undefined);
  }
}

/** Starts the recurring pass; returns the stop function. The first pass waits two minutes so boot is not busy. */
export function startThumbnailBackfill(deps: ThumbnailBackfillDeps): () => void {
  let running = false;
  const pass = (): void => {
    if (running) return;
    running = true;
    runThumbnailPass(deps)
      .catch((error: unknown) => deps.log.warn({ err: error }, 'Thumbnail backfill pass failed'))
      .finally(() => { running = false; });
  };
  const first = setTimeout(pass, FIRST_PASS_DELAY_MS);
  first.unref();
  const timer = setInterval(pass, BACKFILL_INTERVAL_MS);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
