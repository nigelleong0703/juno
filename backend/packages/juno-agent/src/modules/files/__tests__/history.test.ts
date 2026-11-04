/**
 * BACKEND 5.2d: what files.write / files.edit replace is kept (last 20 per path, 14 days, bytes in the blob store), files.restore and the
 * owner's restore put it back, and a restore keeps what it replaced. A write whose old version cannot be kept does not happen.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore } from '../../../testing/store.js';
import type { ToolContext } from '../../../contracts/index.js';
import type { BlobStore } from '../../../contracts/blobs.js';
import type { ComputerClient, ComputerTarget } from '../../../ports/computer/index.js';
import { createFileEditTool } from '../../tools/tools/codingEdit.js';
import { createFileWriteTool } from '../../tools/tools/computerFiles.js';
import { createFileRestoreTool } from '../../tools/tools/filesRestore.js';
import { FileHistoryError, SNAPSHOTS_PER_PATH, SNAPSHOT_RETENTION_MS, historyOf, keepPreviousVersion, restoreSnapshot } from '../history.js';

const AGENT = 'agent-1';
const OTHER = 'agent-2';
const ENV = { workingDirectory: '/workspace', homeDirectory: '/home/a', platform: 'linux' };

/** Two computers (sandbox, Mac) as maps of path to text; a missing file fails the way `cat` does. */
function computers() {
  const files: Record<ComputerTarget, Map<string, string>> = { sandbox: new Map(), mac: new Map() };
  const client = {
    readFile: async (_agent: string, path: string, _signal: AbortSignal, on: ComputerTarget = 'sandbox') => {
      const content = files[on].get(path);
      if (content === undefined) throw new Error(`could not read ${path}: cat: ${path}: No such file or directory`);
      return { content, bytes: Buffer.byteLength(content) };
    },
    writeFile: async (_agent: string, input: { path: string; content: string }, _signal: AbortSignal, on: ComputerTarget = 'sandbox') => {
      files[on].set(input.path, input.content);
      return { path: input.path, bytes: Buffer.byteLength(input.content) };
    },
    environment: async () => ENV,
  } as unknown as ComputerClient;
  return { files, client };
}

function setup(blobs: BlobStore = createMemoryBlobStore()) {
  const store = createMemoryStore();
  const { files, client } = computers();
  const opts = { computer: () => client, environment: async () => ENV as never };
  const write = createFileWriteTool(opts);
  const edit = createFileEditTool(opts);
  const restore = createFileRestoreTool(opts);
  let step = 0;
  const ctx = (agentId = AGENT): ToolContext => ({ agentId, ownerId: 'o1', conversationId: 'c1', runId: 'run-1', stepId: `step-${(step += 1)}`, store, blobs, signal: new AbortController().signal }) as unknown as ToolContext;
  const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((part) => part.text ?? '').join('');
  return { store, blobs, files, client, write, edit, restore, ctx, text };
}

describe('keeping what a write replaces', () => {
  it('keeps nothing for a new file, and the old text of each overwrite and edit, newest first', async () => {
    const { store, blobs, files, write, edit, ctx } = setup();
    expect((await write.execute({ path: '/workspace/a.md', content: 'v1' }, ctx())).details).not.toHaveProperty('snapshotId');
    expect(await historyOf({ store, blobs }, AGENT, { path: '/workspace/a.md', on: 'sandbox' })).toEqual([]);
    await write.execute({ path: '/workspace/a.md', content: 'v2 text' }, ctx());
    await edit.execute({ path: '/workspace/a.md', oldText: 'text', newText: 'words' }, ctx());
    expect(files.sandbox.get('/workspace/a.md')).toBe('v2 words');
    const history = await historyOf({ store, blobs }, AGENT, { path: '/workspace/a.md', on: 'sandbox' });
    expect(history.map((snapshot) => [snapshot.tool, snapshot.sizeBytes])).toEqual([['files.edit', 7], ['files.write', 2]]);
    expect(history[0]).toMatchObject({ agentId: AGENT, runId: 'run-1', conversationId: 'c1', on: 'sandbox', path: '/workspace/a.md' });
    // The bytes are in the blob store; the row holds only a reference, never text.
    expect(JSON.stringify((await store.list('fileSnapshots', {})).items)).not.toContain('v2 text');
  });

  it('keeps the Mac and the sandbox apart, and one agent\'s history apart from another\'s', async () => {
    const { store, blobs, files, write, ctx } = setup();
    files.mac.set('/Users/me/Juno/n.md', 'mac one');
    files.sandbox.set('/Users/me/Juno/n.md', 'sandbox one');
    await write.execute({ path: '/Users/me/Juno/n.md', content: 'mac two', on: 'mac' }, ctx());
    await write.execute({ path: '/Users/me/Juno/n.md', content: 'sandbox two' }, ctx(OTHER));
    const deps = { store, blobs };
    expect((await historyOf(deps, AGENT, { path: '/Users/me/Juno/n.md', on: 'mac' })).map((s) => s.sizeBytes)).toEqual([7]);
    expect(await historyOf(deps, AGENT, { path: '/Users/me/Juno/n.md', on: 'sandbox' })).toEqual([]);
    expect((await historyOf(deps, OTHER, { path: '/Users/me/Juno/n.md', on: 'sandbox' })).map((s) => s.sizeBytes)).toEqual([11]);
  });

  it('keeps the last 20 and drops the older ones; a version older than 14 days is not offered and goes at the next write', async () => {
    const { store, blobs } = setup();
    const target = { path: '/workspace/p.md', on: 'sandbox' as const };
    const deps = { store, blobs };
    let clock = Date.parse('2026-11-01T00:00:00Z');
    for (let version = 0; version < SNAPSHOTS_PER_PATH + 3; version += 1) {
      await keepPreviousVersion(deps, { agentId: AGENT, stepId: `s${version}` }, target, 'files.write', `version ${version}`, undefined, () => (clock += 1000));
    }
    const kept = await historyOf(deps, AGENT, target, () => clock);
    expect(kept).toHaveLength(SNAPSHOTS_PER_PATH);
    expect((await store.list('fileSnapshots', {})).items).toHaveLength(SNAPSHOTS_PER_PATH);
    // The newest is first; the three oldest are gone.
    expect(kept[0]?.sizeBytes).toBe('version 22'.length);
    const later = clock + SNAPSHOT_RETENTION_MS + 1;
    expect(await historyOf(deps, AGENT, target, () => later)).toEqual([]);
    await keepPreviousVersion(deps, { agentId: AGENT, stepId: 'fresh' }, target, 'files.write', 'new', undefined, () => later);
    expect((await store.list('fileSnapshots', {})).items).toHaveLength(1);
  });

  it('does not write when the old version cannot be kept, and says why', async () => {
    const broken: BlobStore = { ...createMemoryBlobStore(), put: async () => { throw new Error('bucket unavailable'); } };
    const { files, write, ctx, text } = setup(broken);
    files.sandbox.set('/workspace/a.md', 'precious');
    const result = await write.execute({ path: '/workspace/a.md', content: 'new' }, ctx());
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('bucket unavailable');
    expect(files.sandbox.get('/workspace/a.md')).toBe('precious');
  });
});

describe('putting a version back', () => {
  it('files.write twice, then the restore brings back the original; the restore itself can be undone', async () => {
    const { store, blobs, files, write, restore, ctx, text } = setup();
    files.sandbox.set('/workspace/a.md', 'original');
    await write.execute({ path: '/workspace/a.md', content: 'first rewrite' }, ctx());
    await write.execute({ path: '/workspace/a.md', content: 'second rewrite' }, ctx());
    const history = await historyOf({ store, blobs }, AGENT, { path: '/workspace/a.md', on: 'sandbox' });
    expect(history).toHaveLength(2);
    // Without an id: the newest kept version, which is the text just before the last write.
    const newest = await restore.execute({ path: '/workspace/a.md' }, ctx());
    expect(files.sandbox.get('/workspace/a.md')).toBe('first rewrite');
    expect(text(newest)).toContain('Restored /workspace/a.md');
    const original = history.find((snapshot) => snapshot.sizeBytes === 'original'.length);
    await restore.execute({ path: '/workspace/a.md', snapshotId: original?.id }, ctx());
    expect(files.sandbox.get('/workspace/a.md')).toBe('original');
    // Each restore kept what it replaced: undoing the last one gives back the text before it.
    const undoable = await historyOf({ store, blobs }, AGENT, { path: '/workspace/a.md', on: 'sandbox' });
    expect(undoable[0]).toMatchObject({ tool: 'files.restore', restoredFrom: original?.id });
    await restore.execute({ path: '/workspace/a.md', snapshotId: undoable[0]?.id }, ctx());
    expect(files.sandbox.get('/workspace/a.md')).toBe('first rewrite');
  });

  it('answers plainly when nothing is kept, or the id is not this agent\'s', async () => {
    const { store, blobs, client, files, write, restore, ctx, text } = setup();
    expect(text(await restore.execute({ path: '/workspace/none.md' }, ctx()))).toContain('No earlier version');
    files.sandbox.set('/workspace/a.md', 'one');
    await write.execute({ path: '/workspace/a.md', content: 'two' }, ctx());
    const [snapshot] = await historyOf({ store, blobs }, AGENT, { path: '/workspace/a.md', on: 'sandbox' });
    expect((await restore.execute({ path: '/workspace/a.md', snapshotId: snapshot?.id }, ctx(OTHER))).isError).toBe(true);
    await expect(restoreSnapshot({ store, blobs, computer: client }, { snapshotId: snapshot?.id ?? '', agentId: OTHER, origin: {}, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    // The owner's route names no agent: the snapshot's own agent acts.
    const done = await restoreSnapshot({ store, blobs, computer: client }, { snapshotId: snapshot?.id ?? '', origin: {}, signal: new AbortController().signal });
    expect(done).toMatchObject({ path: '/workspace/a.md', on: 'sandbox', bytes: 3, undo: { tool: 'files.restore' } });
    expect(files.sandbox.get('/workspace/a.md')).toBe('one');
  });

  it('does not restore over a file it cannot keep a copy of, and reports a missing saved version', async () => {
    const { store, blobs, client, files, write, ctx } = setup();
    files.sandbox.set('/workspace/a.md', 'one');
    await write.execute({ path: '/workspace/a.md', content: 'two' }, ctx());
    const [snapshot] = await historyOf({ store, blobs }, AGENT, { path: '/workspace/a.md', on: 'sandbox' });
    await blobs.delete(`blobs/${snapshot?.sha256}`);
    await expect(restoreSnapshot({ store, blobs, computer: client }, { snapshotId: snapshot?.id ?? '', origin: {}, signal: new AbortController().signal })).rejects.toBeInstanceOf(FileHistoryError);
    expect(files.sandbox.get('/workspace/a.md')).toBe('two');
  });
});
