// Regression evidence for the sandbox-bound coding tools: byte-exact bounded reads, structured edits
// with stale/ambiguous refusal, and bounded grep/find run as the real generated shell program.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../../../contracts/index.js';
import { ComputerError } from '../index.js';
import { LocalShellFiles, SandboxFiles, build, hashOf, requireTool, textOf, toolCtx } from './codingFixtures.js';

type Registry = Awaited<ReturnType<typeof build>>['registry'];

describe('coding tool registry', () => {
  it('registers the file tools only when a sandbox is configured', async () => {
    const { registry } = await build(new SandboxFiles());
    const names = (await registry.forAgent('agent-1')).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['files.read', 'files.write', 'files.edit', 'files.search']));
    const { registry: bare } = await build();
    expect(bare.get('files.read')).toBeUndefined();
    expect(bare.get('files.edit')).toBeUndefined();
  });

  it('marks read/search safe and edit/write non-replayable side effects', async () => {
    const { registry } = await build(new SandboxFiles());
    expect(requireTool(registry, 'files.read').replay).toBe('safe');
    expect(requireTool(registry, 'files.search').replay).toBe('safe');
    expect(requireTool(registry, 'files.search').sideEffect).toBe(false);
    expect(requireTool(registry, 'files.edit').replay).toBe('never');
    expect(requireTool(registry, 'files.edit').sideEffect).toBe(true);
  });
});

describe('files.read bounded ranges', () => {
  let client: SandboxFiles;
  let store: Store;
  let registry: Registry;
  const big = Array.from({ length: 300 }, (_value, index) => 'line ' + (index + 1)).join('\n') + '\n';

  beforeEach(async () => {
    client = new SandboxFiles();
    const built = await build(client);
    store = built.store; registry = built.registry;
  });

  it('bounds a large read and hands back a byte-exact continuation', async () => {
    client.files.set('/workspace/big.txt', big);
    const result = await requireTool(registry, 'files.read').execute({ path: '/workspace/big.txt' }, toolCtx(store));
    expect(result.isError).not.toBe(true);
    expect(textOf(result)).toContain('line 200');
    expect(textOf(result)).not.toContain('line 201');
    expect(result.details).toMatchObject({ startLine: 1, endLine: 200, totalLines: 300, truncated: true, nextStartLine: 201, nextLineOffset: 0 });
    expect(JSON.stringify(result.content)).toContain('continue with startLine=201, lineOffset=0');
  });

  it('reads an explicit line window and a whole small file with a hash', async () => {
    client.files.set('/workspace/big.txt', big);
    const ranged = await requireTool(registry, 'files.read').execute({ path: '/workspace/big.txt', startLine: 5, maxLines: 3 }, toolCtx(store));
    expect(textOf(ranged)).toBe('line 5\nline 6\nline 7\n');
    expect(ranged.details).toMatchObject({ startLine: 5, endLine: 7, nextStartLine: 8, nextLineOffset: 0 });
    client.files.set('/workspace/small.txt', 'a\nb\nc\n');
    const whole = await requireTool(registry, 'files.read').execute({ path: '/workspace/small.txt' }, toolCtx(store));
    expect(textOf(whole)).toBe('a\nb\nc\n');
    expect(whole.details).toMatchObject({ totalLines: 3, truncated: false, hash: hashOf('a\nb\nc\n') });
  });

  it('pages a long multibyte line losslessly and resolves a relative path', async () => {
    const long = 'x'.repeat(200) + 'é中'.repeat(150) + 'z'.repeat(200);
    const content = 'head\n' + long + '\ntail\n';
    client.files.set('/workspace/long.txt', content);
    const midLine = await requireTool(registry, 'files.read').execute({ path: 'long.txt', startLine: 2, maxBytes: 32 }, toolCtx(store));
    expect(midLine.details).toMatchObject({ startLine: 2, endLine: null, truncated: true, nextStartLine: 2, nextLineOffset: 32 });
    expect(Buffer.byteLength(textOf(midLine))).toBe(32);
    let collected = '';
    let args: Record<string, unknown> = { path: 'long.txt', maxBytes: 64 };
    for (let page = 0; page < 200; page += 1) {
      const result = await requireTool(registry, 'files.read').execute(args, toolCtx(store));
      collected += textOf(result);
      const details = result.details ?? {};
      if (details.truncated !== true) break;
      args = { path: 'long.txt', startLine: Number(details.nextStartLine), lineOffset: Number(details.nextLineOffset), maxBytes: 64 };
    }
    expect(collected).toBe(content);
    expect(client.reads.every((read) => read.path === '/workspace/long.txt' && read.agentId === 'agent-1')).toBe(true);
  });
});

describe('files.edit structured edits', () => {
  let client: SandboxFiles;
  let store: Store;
  let registry: Registry;

  beforeEach(async () => {
    client = new SandboxFiles();
    const built = await build(client);
    store = built.store; registry = built.registry;
  });

  it('replaces a unique match through the bound client, scoped to the context agent', async () => {
    client.files.set('/workspace/a.txt', 'hello world');
    const result = await requireTool(registry, 'files.edit').execute({ path: '/workspace/a.txt', oldText: 'world', newText: 'there', expectedHash: hashOf('hello world'), agentId: 'agent-2' }, toolCtx(store));
    expect(result.isError).not.toBe(true);
    expect(client.writes).toEqual([{ path: '/workspace/a.txt', content: 'hello there' }]);
    expect(result.details).toMatchObject({ replaced: 1, hash: hashOf('hello there'), guard: 'hash' });
    expect(client.agentIds.every((id) => id === 'agent-1')).toBe(true);
  });

  it('refuses an ambiguous or missing match without writing', async () => {
    client.files.set('/workspace/a.txt', 'x x');
    const ambiguous = await requireTool(registry, 'files.edit').execute({ path: '/workspace/a.txt', oldText: 'x', newText: 'y' }, toolCtx(store));
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.details).toMatchObject({ code: 'ambiguous', occurrences: 2 });
    const missing = await requireTool(registry, 'files.edit').execute({ path: '/workspace/a.txt', oldText: 'zzz', newText: 'y' }, toolCtx(store));
    expect(missing.details).toMatchObject({ code: 'not_found' });
    expect(client.writes).toHaveLength(0);
  });

  it('refuses a stale edit when expectedHash or expectedContent no longer match', async () => {
    client.files.set('/workspace/a.txt', 'current');
    const byHash = await requireTool(registry, 'files.edit').execute({ path: '/workspace/a.txt', oldText: 'current', newText: 'next', expectedHash: hashOf('older') }, toolCtx(store));
    expect(byHash.isError).toBe(true);
    expect(byHash.details).toMatchObject({ code: 'stale', hash: hashOf('current') });
    const byContent = await requireTool(registry, 'files.edit').execute({ path: '/workspace/a.txt', oldText: 'current', newText: 'next', expectedContent: 'older' }, toolCtx(store));
    expect(byContent.details).toMatchObject({ code: 'stale' });
    expect(client.writes).toHaveLength(0);
  });

  it('replaceAll replaces every occurrence and a sandbox refusal surfaces as a tool error', async () => {
    client.files.set('/workspace/a.txt', 'x\nx');
    const all = await requireTool(registry, 'files.edit').execute({ path: '/workspace/a.txt', oldText: 'x', newText: 'y', replaceAll: true }, toolCtx(store));
    expect(client.writes[0]?.content).toBe('y\ny');
    expect(all.details).toMatchObject({ replaced: 2, guard: 'none' });
    client.failWith = new ComputerError('not_allowed', 'this path is read-only');
    const denied = await requireTool(registry, 'files.edit').execute({ path: '/workspace/a.txt', oldText: 'y', newText: 'z' }, toolCtx(store));
    expect(denied.isError).toBe(true);
    expect(denied.details).toMatchObject({ code: 'not_allowed' });
  });
});

describe('files.search real shell execution', () => {
  let root: string;
  let client: LocalShellFiles;
  let store: Store;
  let registry: Registry;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'vomu-search-'));
    client = new LocalShellFiles(root);
    const built = await build(client);
    store = built.store; registry = built.registry;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a missing path as an error from grep exit 2, and a real match as success', async () => {
    const missing = await requireTool(registry, 'files.search').execute({ query: 'foo', path: 'no-such-dir' }, toolCtx(store));
    expect(missing.isError).toBe(true);
    expect(missing.details).toMatchObject({ exitCode: 2 });
    expect(JSON.stringify(missing.content)).toContain('No such file');
    writeFileSync(join(root, 'a.ts'), 'alpha\nfoo\nfoo\n');
    const found = await requireTool(registry, 'files.search').execute({ query: 'foo' }, toolCtx(store));
    expect(found.isError).not.toBe(true);
    expect(found.details).toMatchObject({ exitCode: 0, matches: 2 });
    expect(textOf(found)).toContain('a.ts:2:foo');
  });

  it('reports no match (grep exit 1) as success with a clear message', async () => {
    const none = await requireTool(registry, 'files.search').execute({ query: 'absent-needle' }, toolCtx(store));
    expect(none.isError).not.toBe(true);
    expect(none.details).toMatchObject({ exitCode: 1, matches: 0 });
    expect(JSON.stringify(none.content)).toContain('No matches');
  });

  it('bounds a large real result at the limit without a spurious pipe failure', async () => {
    writeFileSync(join(root, 'many.txt'), Array.from({ length: 20 }, (_value, index) => 'hit ' + index).join('\n') + '\n');
    const result = await requireTool(registry, 'files.search').execute({ query: 'hit', maxResults: 5 }, toolCtx(store));
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ exitCode: 0, limit: 5, matches: 5, truncated: true });
    expect(textOf(result).split('\n')).toHaveLength(5);
  });

  it('runs find for name mode and never lets a hostile query run a command', async () => {
    writeFileSync(join(root, 'note.md'), '# hi\n');
    const named = await requireTool(registry, 'files.search').execute({ query: '*.md', mode: 'name', maxResults: 5 }, toolCtx(store));
    expect(named.isError).not.toBe(true);
    expect(textOf(named)).toContain('note.md');
    const hostile = await requireTool(registry, 'files.search').execute({ query: "a'; touch pwned; '", maxResults: 5 }, toolCtx(store));
    expect(hostile.isError).not.toBe(true);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
    expect(client.agentIds.every((id) => id === 'agent-1')).toBe(true);
    expect(client.shellCalls[1]?.cwd).toBe(root);
    expect(client.shellCalls[1]?.command).toContain("-e 'a'\\''; touch pwned; '\\'''");
  });
});

describe('the /juno home through the file tools (BACKEND §5.2, §5.7)', () => {
  it('writes nothing in /juno through the file tools, not even the agent\'s own daily log (memory changes only through memory_note and the jobs)', async () => {
    const client = new SandboxFiles();
    const { store, registry } = await build(client);
    const ctx = toolCtx(store);
    const own = '/juno/memory/2026-10-14/' + ctx.agentId + '.md';
    client.files.set(own, '- 09:00 [fact] user: kept\n');
    const write = (path: string) => requireTool(registry, 'files.write').execute({ path, content: 'x' }, ctx);
    for (const path of [own, '/juno/MEMORY.md', '/juno/USER.md', '/juno/../juno/MEMORY.md', '/juno/memory/bank/preferences.md', '/juno/memory/2026-10-14/other-agent.md', '/juno/people/mina.md', '/juno/groups/discord-ab12.md', '/juno/agents/' + ctx.agentId + '/SOUL.md']) {
      const refused = await write(path);
      expect(refused.isError, path).toBe(true);
      expect(refused.details, path).toMatchObject({ code: expect.stringMatching(/^(protected_path|foreign_agent_path)$/) });
    }
    const edit = await requireTool(registry, 'files.edit').execute({ path: own, oldText: 'kept', newText: 'changed' }, ctx);
    expect(edit.isError).toBe(true);
    expect(edit.details).toMatchObject({ code: 'protected_path' });
    expect(textOf(edit)).toContain('memory_note');
    expect(client.files.get(own)).toBe('- 09:00 [fact] user: kept\n');
    expect(client.files.has('/juno/USER.md')).toBe(false);
    // A path outside /juno is not the guard's business.
    expect((await write('/workspace/notes.md')).isError).not.toBe(true);
  });

  it('keeps the private memory files out of reach of a run with other people in it, and lets the owner\'s own chat read them', async () => {
    const client = new SandboxFiles();
    const { store, registry } = await build(client);
    await store.put('agents', { id: 'agent-1', name: 'Juno', ownerId: 'owner', createdAt: '2026-10-08T00:00:00.000Z' } as never);
    await store.put('conversations', { id: 'conv-1', kind: 'direct', agentIds: ['agent-1'], memberIds: [], unreadCount: 0, lastItemAt: '2026-10-08T00:00:00.000Z', createdAt: '2026-10-08T00:00:00.000Z' } as never);
    const owner = toolCtx(store);
    client.files.set('/juno/MEMORY.md', '# Memory\n- lives in Leiden\n');
    client.files.set('/juno/memory/2026-10-14/agent-1.md', '- 09:00 [fact] user: secret\n');
    client.files.set('/juno/docs/memory.md', '# How memory works\n');
    client.files.set('/juno/agents/agent-1/SOUL.md', 'principles');
    const read = (ctx: typeof owner, path: string) => requireTool(registry, 'files.read').execute({ path }, ctx);
    expect(textOf(await read(owner, '/juno/MEMORY.md'))).toContain('Leiden');
    // A group room (someone besides the owner), and a stranger's wake in the owner's own chat.
    await store.put('conversations', { id: 'room-1', kind: 'room', agentIds: ['agent-1'], memberIds: ['owner', 'ext-discord-0123456789abcdef'], unreadCount: 0, lastItemAt: '2026-10-08T00:00:00.000Z', createdAt: '2026-10-08T00:00:00.000Z' } as never);
    const group = { ...owner, conversationId: 'room-1' };
    const stranger = { ...owner, wake: { ...owner.wake, origin: { type: 'user' as const, id: 'ext-discord-0123456789abcdef' }, trusted: false } };
    for (const ctx of [group, stranger]) {
      for (const path of ['/juno/MEMORY.md', '/juno/USER.md', '/juno/memory/2026-10-14/agent-1.md', '/juno/memory/bank/preferences.md', '/juno/people/mina.md', '/juno/groups/discord-ab12.md', '/juno/../juno/MEMORY.md']) {
        const refused = await read(ctx, path);
        expect(refused.isError, path).toBe(true);
        expect(refused.details, path).toMatchObject({ code: 'private_memory' });
        expect(textOf(refused)).not.toContain('Leiden');
      }
      // A search that starts at the home root would walk into them too.
      expect((await requireTool(registry, 'files.search').execute({ query: 'secret', path: '/juno' }, ctx)).details).toMatchObject({ code: 'private_memory' });
      expect((await requireTool(registry, 'files.search').execute({ query: 'secret', path: '/juno/memory' }, ctx)).details).toMatchObject({ code: 'private_memory' });
      // What is not private memory stays readable: the platform docs and the agent's own files.
      expect(textOf(await read(ctx, '/juno/docs/memory.md'))).toContain('How memory works');
      expect(textOf(await read(ctx, '/juno/agents/agent-1/SOUL.md'))).toBe('principles');
    }
    // The owner's own chat can still search the memory.
    expect((await requireTool(registry, 'files.search').execute({ query: 'secret', path: '/juno/memory' }, owner)).details).not.toMatchObject({ code: 'private_memory' });
  });

  it('keeps one agent out of another agent\'s files', async () => {
    const client = new SandboxFiles();
    const { store, registry } = await build(client);
    const ctx = toolCtx(store);
    const foreign = '/juno/agents/agt-other/SOUL.md';
    client.files.set('/juno/agents/agt-other/SOUL.md', 'secret persona');
    const read = await requireTool(registry, 'files.read').execute({ path: foreign }, ctx);
    expect(read.isError).toBe(true);
    expect(textOf(read)).toContain('agent_directory');
    expect(textOf(read)).not.toContain('secret persona');
    expect((await requireTool(registry, 'files.search').execute({ query: 'secret', path: '/juno/agents' }, ctx)).isError).toBe(true);
    const mine = await requireTool(registry, 'files.read').execute({ path: '/juno/agents/' + ctx.agentId + '/SOUL.md' }, ctx);
    expect(textOf(mine)).not.toContain('agent_directory');
  });
});
