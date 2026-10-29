// artifact_publish also records what the agent did as one experience item about the owner (BACKEND §5.11), so memory_search finds
// "the page I made last time" from another chat. Runs on the embedded memory database; the sandbox read is the same fake send_file uses.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Conversation } from '@agent-desktop/public-contracts';
import type { ToolContext } from '../../../contracts/index.js';
import type { ShellInput, ShellOutput } from '../../../ports/computer/index.js';
import { portOf, startMemoryGraph, type MemoryGraphFixture } from '../../memory/__tests__/memory-graph-fixture.js';
import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createMemoryStore } from '../../../testing/store.js';
import { createArtifactPublishTool } from '../tools/artifactPublish.js';
import { NoopEnqueuer, SandboxFiles } from './codingFixtures.js';

const OWNER = 'owner-publish-memory';
const NOW = '2026-10-28T00:00:00.000Z';

/** The sandbox with one file on its disk; `runShell` answers the bounded reader the way the real script does. */
class Disk extends SandboxFiles {
  bytes = new Map<string, Buffer>();
  override async runShell(_agentId: string, input: ShellInput): Promise<ShellOutput> {
    const path = /'([^']*)'$/.exec(input.command)?.[1] ?? '';
    const bytes = this.bytes.get(path);
    if (bytes === undefined) return { stdout: '', stderr: 'No such file', exitCode: 1 };
    return { stdout: JSON.stringify({ contentBase64: bytes.toString('base64'), sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }), stderr: '', exitCode: 0 };
  }
}

let graph: MemoryGraphFixture;
beforeAll(async () => {
  graph = await startMemoryGraph();
});
afterAll(async () => {
  await graph.close();
});

async function setup() {
  const store = createMemoryStore();
  const disk = new Disk();
  disk.bytes.set('/workspace/notes.md', Buffer.from('# Juno 1.0\nWhat is new'));
  await store.put('agents', { id: 'agent-1', name: 'Juno', ownerId: OWNER, createdAt: NOW } as never);
  const base = { agentIds: ['agent-1'], memberIds: [OWNER], unreadCount: 0, lastItemAt: NOW, createdAt: NOW };
  await store.put('conversations', { ...base, id: 'conv-dm', kind: 'direct', title: 'Release notes' } as Conversation);
  await store.put('conversations', { ...base, id: 'conv-group', kind: 'room', title: 'Team', channel: { kind: 'telegram', channelId: 'bot', chatId: '-100' } } as never);
  await graph.graph.identity.ensureOwner(OWNER, 'Robin');
  const port = portOf(graph, store);
  const ctx = (conversationId: string): ToolContext => ({
    ownerId: OWNER, agentId: 'agent-1', conversationId, runId: 'run-1', store, blobs: createMemoryBlobStore(), enqueuer: new NoopEnqueuer(),
    wake: { id: 'wke_1', ownerId: OWNER, agentId: 'agent-1', sessionKey: 'agent-1:' + conversationId, conversationId, kind: 'user_message', origin: { type: 'user', id: OWNER }, trusted: true, priority: 'user', payload: {}, at: NOW, status: 'accepted' },
    step: async (_name, fn) => fn(), signal: new AbortController().signal,
  });
  const tool = (memory = port) => createArtifactPublishTool({ store, memory, computer: () => disk, environment: async () => disk.env });
  return { store, disk, port, ctx, tool };
}

const experiences = async (owner = OWNER) => (await graph.graph.items.listItems(owner)).filter((item) => item.kind === 'experience');

describe('artifact_publish memory record', () => {
  it('records one experience item for the owner, marked as the agent\'s, with the chat\'s audience', async () => {
    const s = await setup();
    const result = await s.tool().execute({ path: '/workspace/notes.md', title: 'Juno 1.0 release notes' }, s.ctx('conv-dm'));
    expect(result.isError).not.toBe(true);
    const artifactId = (result.details as { artifactId: string }).artifactId;
    const [item, ...rest] = await experiences();
    expect(rest).toHaveLength(0);
    expect(item).toMatchObject({ kind: 'experience', topic: 'work', saidByAgentId: 'agent-1', saidByPersonId: null, audience: 'owner', saidIn: 'app', status: 'active' });
    expect(item?.text).toContain('"Juno 1.0 release notes"');
    expect(item?.text).toContain(`artifactId ${artifactId}`);
    expect(item?.text).toContain('/workspace/notes.md');
    // memory_search finds it.
    const hits = await s.port.search({ ownerId: OWNER, presence: { kind: 'owner' }, agentId: 'agent-1', query: 'Juno 1.0 release notes page' });
    expect(hits.map((hit) => hit.item.id)).toContain(item?.id);
  });

  it('keeps a page made in a group room to that room\'s audience', async () => {
    const s = await setup();
    await s.tool().execute({ path: '/workspace/notes.md', title: 'Team plan' }, s.ctx('conv-group'));
    const items = (await experiences()).filter((item) => item.text.includes('"Team plan"'));
    expect(items).toHaveLength(1);
    expect(items[0]?.audience).toMatch(/^group:/);
  });

  it('updates the same line for a new version instead of adding a second item', async () => {
    const s = await setup();
    const first = await s.tool().execute({ path: '/workspace/notes.md', title: 'Versioned page' }, s.ctx('conv-dm'));
    const artifactId = (first.details as { artifactId: string }).artifactId;
    const before = (await experiences()).filter((item) => item.text.includes(artifactId));
    expect(before).toHaveLength(1);
    const second = await s.tool().execute({ path: '/workspace/notes.md', title: 'Versioned page', artifactId }, s.ctx('conv-dm'));
    expect((second.details as { version: number }).version).toBe(2);
    const after = (await experiences()).filter((item) => item.text.includes(artifactId));
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.text).toContain('(version 2)');
  });

  it('still returns the publish when memory fails', async () => {
    const s = await setup();
    const broken = { ...s.port, note: async () => { throw new Error('memory is down'); }, owner: { ...s.port.owner, items: async () => { throw new Error('memory is down'); } } };
    const result = await s.tool(broken).execute({ path: '/workspace/notes.md', title: 'Still published' }, s.ctx('conv-dm'));
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ memoryRecordFailed: 'memory is down' });
    expect(await s.store.get('library', (result.details as { artifactId: string }).artifactId)).not.toBeNull();
  });

  it('publishes as before when the deployment has no memory', async () => {
    const s = await setup();
    const tool = createArtifactPublishTool({ store: s.store, computer: () => s.disk, environment: async () => s.disk.env });
    const result = await tool.execute({ path: '/workspace/notes.md', title: 'No memory' }, s.ctx('conv-dm'));
    expect(result.isError).not.toBe(true);
    expect(result.details).not.toHaveProperty('memoryRecordFailed');
  });
});
