import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { ComputerClient } from 'juno-agent/computer';
import { saveBlob, type BlobStore, type LibraryDocument, type Store } from 'juno-agent/contracts';
import { BACKFILL_PER_OWNER, runThumbnailPass, type ThumbnailBackfillDeps } from '../thumbnails.js';

const OWNER = 'owner-backfill';
const PNG = Buffer.from('a page rendered to pixels');
const PAGE = '<!doctype html><title>Trip</title><h1>Trip</h1>';
const noLog = { info: () => undefined, warn: () => undefined };

function memoryBlobs(): BlobStore {
  const data = new Map<string, Buffer>();
  return {
    async put(key, bytes) { data.set(key, Buffer.from(bytes)); },
    async get(key) { return data.get(key) ?? null; },
    async delete(key) { data.delete(key); },
  };
}

/** A computer that holds files in memory and answers the screenshot and the file reader the way the real image does. */
function fakeComputer(shot: 'png' | 'no-browser', commands: string[]): ComputerClient {
  const files = new Map<string, Buffer>();
  return {
    environment: async () => ({ os: 'Debian', platform: 'linux', user: 'agent', home: '/home/agent', workingDirectory: '/workspace', pathStyle: 'posix', kind: 'sandbox' }),
    writeFile: async (_agent: string, input: { path: string; content: string }) => {
      commands.push('writeFile ' + input.path);
      files.set(input.path, Buffer.from(input.content, 'utf8'));
      return undefined;
    },
    runShell: async (_agent: string, input: { command: string }) => {
      const { command } = input;
      commands.push(command);
      if (command === 'mktemp -d') return { stdout: '/tmp/thumb-dir\n', stderr: '', exitCode: 0 };
      if (command.includes('--screenshot=')) {
        if (shot === 'no-browser') return { stdout: '', stderr: '', exitCode: 9 };
        files.set('/tmp/thumb-dir/thumb.png', PNG);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command.startsWith("python3 -c '")) {
        const path = /'([^']*)'$/.exec(command)?.[1] ?? '';
        const bytes = files.get(path);
        if (bytes === undefined) return { stdout: '', stderr: 'No such file', exitCode: 1 };
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        return { stdout: JSON.stringify({ contentBase64: bytes.toString('base64'), sizeBytes: bytes.length, sha256 }), stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  } as unknown as ComputerClient;
}

/** Publishes `count` HTML artifacts (one version each) for the owner, the way artifact_publish stored them before thumbnails existed. */
async function seedPages(store: Store, blobs: BlobStore, count: number): Promise<void> {
  const scoped = store.forOwner?.(OWNER);
  if (scoped === undefined) throw new Error('owner-scoped store expected');
  for (let i = 0; i < count; i += 1) {
    const stored = await saveBlob(blobs, Buffer.from(PAGE + String(i)), 'text/html');
    const fileId = 'af-page-' + String(i);
    const at = '2026-10-20T00:00:00.000Z';
    await scoped.put('artifactFiles', {
      id: fileId, artifactId: 'lib-page-' + String(i), version: 1, part: 'file', name: 'trip.html', mimeType: 'text/html',
      sizeBytes: stored.sizeBytes, sha256: stored.sha256, blobKey: stored.blobKey, createdAt: at,
    }, { parentId: 'lib-page-' + String(i) });
    const doc: LibraryDocument = {
      id: 'lib-page-' + String(i), name: 'Trip ' + String(i), kind: 'canvas', mimeType: 'text/html', sizeBytes: stored.sizeBytes,
      createdByAgentId: 'agent-1', conversationId: 'conv-1', shared: 'private', source: 'agent', tags: [], createdAt: at, updatedAt: at,
      pinned: false, render: 'html', version: 1,
      versions: [{ version: 1, fileRef: fileId, sizeBytes: stored.sizeBytes, mimeType: 'text/html', createdAt: at }],
    };
    await scoped.put('library', doc);
  }
}

function deps(store: Store, blobs: BlobStore, computer: ComputerClient, running: boolean): ThumbnailBackfillDeps {
  const scoped = store.forOwner?.(OWNER);
  if (scoped === undefined) throw new Error('owner-scoped store expected');
  return {
    store,
    blobs,
    computer,
    computerd: { computerState: async () => (running ? 'running' : 'paused') },
    candidates: async () => (await scoped.list('library', { limit: 200 })).items.map((doc) => ({ ownerId: OWNER, doc })),
    log: noLog,
  };
}

describe('thumbnail backfill', () => {
  it('leaves a paused computer alone: no computer call and no marker', async () => {
    const store = createMemoryStore();
    const blobs = memoryBlobs();
    await seedPages(store, blobs, 2);
    const commands: string[] = [];
    const result = await runThumbnailPass(deps(store, blobs, fakeComputer('png', commands), false));
    expect(result).toMatchObject({ pending: 2, ownersSkipped: 1, attempted: 0, stored: 0 });
    expect(commands).toEqual([]);
    expect((await store.forOwner?.(OWNER)?.get('library', 'lib-page-0'))?.thumbnailTried).toBeUndefined();
  });

  it('gives a running owner at most 20 versions a pass, and each version is tried once', async () => {
    const store = createMemoryStore();
    const blobs = memoryBlobs();
    await seedPages(store, blobs, BACKFILL_PER_OWNER + 5);
    const computer = fakeComputer('png', []);
    expect(await runThumbnailPass(deps(store, blobs, computer, true))).toMatchObject({ pending: 25, attempted: 20, stored: 20 });
    expect(await runThumbnailPass(deps(store, blobs, computer, true))).toMatchObject({ pending: 5, attempted: 5, stored: 5 });
    expect(await runThumbnailPass(deps(store, blobs, computer, true))).toMatchObject({ pending: 0, attempted: 0 });
  });

  it('stores the screenshot as the version thumbnail and marks the version tried', async () => {
    const store = createMemoryStore();
    const blobs = memoryBlobs();
    await seedPages(store, blobs, 1);
    await runThumbnailPass(deps(store, blobs, fakeComputer('png', []), true));
    const scoped = store.forOwner?.(OWNER);
    const doc = await scoped?.get('library', 'lib-page-0');
    const thumbnailRef = doc?.versions?.[0]?.thumbnailRef;
    expect(thumbnailRef).toBeDefined();
    const row = await scoped?.get('artifactFiles', thumbnailRef ?? '');
    expect(row).toMatchObject({ artifactId: 'lib-page-0', version: 1, part: 'thumbnail', mimeType: 'image/png', sizeBytes: PNG.length });
    expect(doc?.thumbnailTried).toEqual([1]);
  });

  it('marks a version whose page has no browser, so it is not tried again', async () => {
    const store = createMemoryStore();
    const blobs = memoryBlobs();
    await seedPages(store, blobs, 1);
    const computer = fakeComputer('no-browser', []);
    expect(await runThumbnailPass(deps(store, blobs, computer, true))).toMatchObject({ attempted: 1, stored: 0 });
    expect(await runThumbnailPass(deps(store, blobs, computer, true))).toMatchObject({ pending: 0, attempted: 0 });
    expect((await store.forOwner?.(OWNER)?.get('library', 'lib-page-0'))?.versions?.[0]?.thumbnailRef).toBeUndefined();
  });
});
