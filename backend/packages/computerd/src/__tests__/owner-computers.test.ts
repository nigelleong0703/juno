import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScreenResponse } from '@agent-desktop/contracts';
import { agentSchema } from '@agent-desktop/public-contracts';
import { createMemoryStore } from '@agent-desktop/db';
import { createFakeProvider, type FakeProvider } from '@agent-desktop/sandbox-adapters';
import { createOwnerComputers } from '../modules/computers/owner-computers.js';
import { createOwnerComputerApp } from '../transport/owner-routes.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Minimal valid agent fixture; the owner boundary is what these tests exercise, not seed realism. */
const agentFixture = agentSchema.parse({
  id: 'agent-fixture',
  name: 'Fixture Agent',
  handle: 'fixture',
  avatar: { shape: 'circle', color: 1, eyes: 'dot' },
  title: 'Fixture',
  status: 'idle',
  section: 'Personal',
  pinned: false,
  lastActivity: '',
  unreadCount: 0,
  model: {
    planner: { provider: 'fixture', model: 'fixture' },
    computer: { provider: 'fixture', model: 'fixture' },
    fast: { provider: 'fixture', model: 'fixture' },
  },
  channels: [],
  macAccess: false,
  skillIds: [],
  pluginIds: [],
  sharing: { publishedToTeam: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'owner-computers-'));
  directories.push(dir);
  const store = createMemoryStore();
  if (!store.forOwner) throw new Error('scoped store required');
  for (const owner of ['legacy', 'alice', 'bob', '../../escape']) {
    await store.forOwner(owner).put('agents', { ...agentFixture, id: `agent-${owner}`, createdBy: owner });
  }
  const providers = new Map<string, FakeProvider>();
  const providerForOwner = vi.fn((owner: string) => {
    const provider = createFakeProvider({ sandboxId: `vm-${createHash('sha256').update(owner).digest('hex')}` });
    providers.set(owner, provider);
    return provider;
  });
  const options = {
    store, legacyOwnerId: 'legacy', bindingFile: join(dir, 'binding.json'), poolFile: join(dir, 'pool.json'),
    host: { template: 'test', resolution: '1280x800', timeoutMs: 1000, ramGb: 2, vcpu: 2, idlePauseMinutes: 30 },
    secret: 'test', legacyBinding: { sandboxId: 'legacy-vm', template: 'test' }, providerForOwner,
  };
  const computers = createOwnerComputers(options);
  const app = createOwnerComputerApp({ computers, token: 'service' });
  const request = (owner: string, path: string, body?: unknown, agent = `agent-${owner}`) => app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer service', 'x-owner-id': owner, 'x-agent-id': agent, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const provider = (owner: string) => {
    const value = providers.get(owner);
    if (!value) throw new Error('provider not created');
    return value;
  };
  return { dir, options, computers, app, request, provider, providerForOwner };
}

describe('owner computer boundary', () => {
  it('requires bearer and nonempty owner before any registry access; caches providers once', async () => {
    const f = await fixture();
    const lookup = vi.spyOn(f.computers, 'forOwner');
    for (const headers of [
      {}, { authorization: 'Bearer service' }, { authorization: 'Bearer service', 'x-owner-id': ' ' },
      { authorization: 'Bearer wrong', 'x-owner-id': 'legacy' }, { 'x-owner-id': 'legacy' },
    ]) expect((await f.app.request('/v1/computer', { headers })).status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(f.providerForOwner).not.toHaveBeenCalled();
    await Promise.all([f.request('alice', '/v1/computer'), f.request('alice', '/v1/screens')]);
    expect(f.providerForOwner).toHaveBeenCalledTimes(1);
    expect(f.computers.forOwner('alice')).toBe(f.computers.forOwner('alice'));
    expect(() => f.computers.forOwner('')).toThrow();
  });

  it('isolates HTTP screens, files, actions, control and pause across two owners', async () => {
    const f = await fixture();
    for (const owner of ['alice', 'bob']) {
      expect((await f.request(owner, '/v1/screens/self/ensure', {})).status).toBe(200);
      expect((await f.request(owner, '/v1/screens/self/files/write', { path: '/shared', content: owner })).status).toBe(200);
      expect((await f.request(owner, '/v1/screens/self/shell/run', { command: `echo ${owner}` })).status).toBe(200);
    }
    const alice = await f.computers.forOwner('alice').lifecycle.getScreen('agent-alice');
    const bob = await f.computers.forOwner('bob').lifecycle.getScreen('agent-bob');
    if (!alice || !bob) throw new Error('missing screens');
    expect(alice.computerId).not.toBe(bob.computerId);
    expect(alice.displayNo).toBe(bob.displayNo);
    for (const owner of ['alice', 'bob']) {
      expect(await (await f.request(owner, '/v1/screens/self/files/read', { path: '/shared' })).json()).toMatchObject({ content: owner });
      expect(f.provider(owner).shellCalls).toEqual([`echo ${owner}`]);
      const foreign = owner === 'alice' ? bob : alice;
      expect((await f.request(owner, `/v1/screens/${foreign.id}`)).status).toBe(404);
      expect(await (await f.request(owner, '/v1/screens')).json()).toMatchObject({ items: [{ ownerId: owner }] });
      for (const path of ['ensure', 'files/read', 'files/write', 'shell/run', 'take-over', 'return-control']) {
        expect((await f.request(owner, `/v1/screens/self/${path}`, { path: '/shared', content: 'attack', command: 'attack' }, foreign.agentId)).status).toBe(403);
      }
      expect(f.provider(owner).files.get('/shared')).toBe(owner);
      expect(f.provider(owner).shellCalls).toEqual([`echo ${owner}`]);
    }
    expect((await f.request('alice', '/v1/screens/self/take-over', {})).status).toBe(200);
    expect((await f.request('alice', '/v1/screens/self/click', { x: 1, y: 2 })).status).toBe(409);
    expect((await f.request('bob', '/v1/screens/self/click', { x: 1, y: 2 })).status).toBe(204);
    // The control row is the truth, and only for that owner's screen.
    const rows = (owner: string) => f.options.store.forOwner?.(owner).get('controls', `screen:${owner === 'alice' ? alice.id : bob.id}`);
    expect((await rows('alice'))?.holder).toBe('user');
    expect((await rows('bob'))?.holder ?? 'agent').toBe('agent');
    expect((await f.request('alice', '/v1/screens/self/return-control', {})).status).toBe(200);
    // After a hand-back the agent must look before it acts: a click is refused, a screenshot is not, and then the click goes through.
    const early = await f.request('alice', '/v1/screens/self/click', { x: 1, y: 2 });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: 'user_control', holder: 'agent', reason: 'inspect_first' });
    expect((await f.request('alice', '/v1/screens/self/screenshot', {})).status).toBe(200);
    expect((await f.request('alice', '/v1/screens/self/click', { x: 1, y: 2 })).status).toBe(204);
    expect((await f.request('alice', '/v1/computer/pause', {})).status).toBe(200);
    expect(f.provider('alice').state.pauseCalls).toBe(1);
    expect(f.provider('bob').state.pauseCalls).toBe(0);
    const bobConnects = f.provider('bob').state.connectCalls;
    expect((await f.request('alice', '/v1/computer/resume', {})).status).toBe(200);
    expect(f.provider('bob').state.connectCalls).toBe(bobConnects);
  });

  it('preserves legacy files and recovers separate bindings/display pools using hashed paths', async () => {
    const f = await fixture();
    const binding = JSON.stringify({ sandboxId: 'existing-legacy', template: 'old' });
    writeFileSync(f.options.bindingFile, binding);
    const signal = AbortSignal.timeout(3000);
    await f.computers.forOwner('legacy').lifecycle.ensureScreen('agent-legacy', signal);
    const pool = readFileSync(f.options.poolFile, 'utf8');
    if (!f.options.store.forOwner) throw new Error('scoped store required');
    const aliceStore = f.options.store.forOwner('alice');
    const aliceAgent = await aliceStore.get('agents', 'agent-alice');
    if (!aliceAgent) throw new Error('missing alice');
    await aliceStore.put('agents', { ...aliceAgent, id: 'alice-second' });
    const screens = new Map<string, ScreenResponse>();
    for (const owner of ['alice', 'bob', '../../escape']) {
      const screen = await f.computers.forOwner(owner).lifecycle.ensureScreen(`agent-${owner}`, signal);
      screens.set(owner, screen);
      const hash = createHash('sha256').update(owner).digest('hex');
      expect(JSON.parse(readFileSync(join(f.dir, 'owners', hash, 'binding.json'), 'utf8'))).toMatchObject({ sandboxId: screen.computerId });
    }
    const second = await f.computers.forOwner('alice').lifecycle.ensureScreen('alice-second', signal);
    expect(second.displayNo).not.toBe(screens.get('alice')?.displayNo);
    const restarted = createOwnerComputers(f.options);
    // Request the second lease first, so a lost pool cannot pass by reallocating in the old order.
    expect(await restarted.forOwner('alice').lifecycle.ensureScreen('alice-second', signal)).toMatchObject({
      id: second.id, computerId: second.computerId, displayNo: second.displayNo,
    });
    for (const owner of ['alice', 'bob', '../../escape']) {
      const scope = restarted.forOwner(owner);
      const create = vi.spyOn(scope.provider, 'create');
      const previous = screens.get(owner);
      if (!previous) throw new Error('missing previous screen');
      expect(await scope.lifecycle.ensureScreen(`agent-${owner}`, signal)).toMatchObject({
        id: previous.id, computerId: previous.computerId, displayNo: previous.displayNo,
      });
      expect(create).not.toHaveBeenCalled();
    }
    expect((await restarted.forOwner('legacy').lifecycle.ensureComputer(signal)).sandboxId).toBe('existing-legacy');
    expect(readFileSync(f.options.bindingFile, 'utf8')).toBe(binding);
    expect(readFileSync(f.options.poolFile, 'utf8')).toBe(pool);
  });
});

describe('deleting an owner\'s computer (account deletion)', () => {
  const signal = () => AbortSignal.timeout(3000);
  const hashOf = (owner: string) => createHash('sha256').update(owner).digest('hex');

  /** The fixture's owners, with a provider whose `erase` records what it was asked to remove. */
  async function erasable() {
    const f = await fixture();
    const erased: Array<{ owner: string; sandboxId: string | null }> = [];
    const computers = createOwnerComputers({
      ...f.options,
      providerForOwner: (owner) => Object.assign(createFakeProvider({ sandboxId: `vm-${owner}` }), {
        erase: async (binding: { sandboxId: string } | null) => { erased.push({ owner, sandboxId: binding?.sandboxId ?? null }); return { computers: binding ? 1 : 0, removed: [`volume juno-vol-${owner}`] }; },
      }),
    });
    return { ...f, computers, erased };
  }

  it('removes that owner\'s computer and state directory only, then refuses the owner for good; a retry is harmless', async () => {
    const f = await erasable();
    for (const owner of ['alice', 'bob', '../../escape']) await f.computers.forOwner(owner).lifecycle.ensureScreen(`agent-${owner}`, signal());
    const aliceDir = join(f.dir, 'owners', hashOf('alice'));
    expect(existsSync(aliceDir)).toBe(true);

    const first = await f.computers.erase('alice', signal());
    expect(first).toEqual({ computers: 1, removed: ['volume juno-vol-alice'], files: [aliceDir] });
    expect(f.erased).toEqual([{ owner: 'alice', sandboxId: expect.stringContaining('vm-alice') }]);
    expect(existsSync(aliceDir)).toBe(false);
    // The others and the legacy files are untouched.
    for (const owner of ['bob', '../../escape']) expect(existsSync(join(f.dir, 'owners', hashOf(owner), 'binding.json'))).toBe(true);
    expect(() => f.computers.forOwner('alice')).toThrow('this account was deleted');
    await expect(f.computers.forOwner('bob').lifecycle.ensureScreen('agent-bob', signal())).resolves.toMatchObject({ ownerId: 'bob' });

    // Run again (a crash after this step): still fine, nothing left to remove, and it asks the platform again (its own labels decide).
    const second = await f.computers.erase('alice', signal());
    expect(second.files).toEqual([]);
    expect(f.erased.at(-1)).toEqual({ owner: 'alice', sandboxId: null });
    expect(() => f.computers.forOwner('alice')).toThrow('this account was deleted');
  });

  it('removes the unscoped files of the legacy owner, including the archived bindings, and not another owner\'s', async () => {
    const f = await erasable();
    writeFileSync(f.options.bindingFile, JSON.stringify({ sandboxId: 'existing-legacy', template: 'old' }));
    await f.computers.forOwner('legacy').lifecycle.ensureScreen('agent-legacy', signal());
    mkdirSync(join(f.dir, 'bindings-archive'));
    writeFileSync(join(f.dir, 'bindings-archive', 'old.json'), '{}');
    await f.computers.forOwner('bob').lifecycle.ensureScreen('agent-bob', signal());
    const { files } = await f.computers.erase('legacy', signal());
    expect(files.sort()).toEqual([f.options.bindingFile, f.options.poolFile, join(f.dir, 'bindings-archive')].sort());
    expect(existsSync(join(f.dir, 'owners', hashOf('bob'), 'binding.json'))).toBe(true);
  });

  it('is an owner route that needs the bearer and an owner, and answers with what it removed', async () => {
    const f = await erasable();
    const app = createOwnerComputerApp({ computers: f.computers, token: 'service' });
    for (const headers of [{}, { authorization: 'Bearer service' }, { authorization: 'Bearer wrong', 'x-owner-id': 'alice' }]) {
      expect((await app.request('/v1/owner', { method: 'DELETE', headers })).status).toBe(403);
    }
    expect(f.erased).toEqual([]);
    const response = await app.request('/v1/owner', { method: 'DELETE', headers: { authorization: 'Bearer service', 'x-owner-id': 'alice' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ computers: 0, removed: ['volume juno-vol-alice'], files: [], macRevoked: false });
    expect(f.erased).toEqual([{ owner: 'alice', sandboxId: null }]);
  });
});
