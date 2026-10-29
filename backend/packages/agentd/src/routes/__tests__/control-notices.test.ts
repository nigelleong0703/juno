/**
 * Takeover and hand-back reach the agent as system wakes: a live run is steered, an idle session only keeps
 * a context note (no run starts), and a run the takeover held up and that then ended is continued. computerd says whether a call
 * moved control (`changed`); agentd never reads the screen first. The same change announced from the route and from the
 * `control.changed` event carries one wake id, so a duplicate delivery takes effect once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { ControlState, Store, SurfaceRef, WakeEvent } from '@agent-desktop/contracts';
import type { ScreenResponse } from '@agent-desktop/contracts';
import type { Agent, AgentEvent, Run } from '@agent-desktop/public-contracts';
import { startControlNotices } from '../control-notices.js';
import { createTestApp, ownerHeaders, withDefaultOwner } from '../../__tests__/test-app.js';
import { getConfig } from '../../config.js';
import type { ComputerdClient, HandBack } from '../../computerd.js';

const OWNER = 'member-robin';
const AT = new Date().toISOString();

function screen(controller: 'agent' | 'user'): ScreenResponse {
  return {
    id: 'scr-1', ownerId: OWNER, computerId: 'sbx', agentId: 'agent-atlas', displayNo: 2, state: 'live', controller, controlEpoch: controller === 'user' ? 1 : 2,
    controllerSince: AT, title: 't', resolution: '1280x800', lastUsedAt: AT, lastVncPort: 5902, lastWebPort: 6082,
  };
}

function run(id: string, status: Run['status'], finishedAt?: string): Run {
  return {
    id, agentId: 'agent-atlas', conversationId: 'conv-1', title: 'x', status, kind: 'chat', steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT, lastActivityAt: AT, ...(finishedAt ? { finishedAt } : {}),
  };
}

/** `handBack` present = the return-control call moved control; `took` = the take-over call moved control (computerd's `changed`). */
async function build(handBack: HandBack | undefined, took = true) {
  const store: Store = withDefaultOwner(createMemoryStore(), getConfig().OWNER_ID);
  const sent: WakeEvent[] = [];
  const computerd: ComputerdClient = {
    computer: async () => ({ sandboxId: 'sbx', template: 't', screens: [], metrics: null }),
    screens: async () => [screen('user')],
    screenById: async (id) => (id === 'scr-1' ? screen(handBack ? 'user' : 'agent') : null),
    ensureScreen: async () => screen('agent'),
    takeOver: async () => ({ ...screen('user'), changed: took }),
    returnControl: async () => ({ ...screen('agent'), changed: handBack !== undefined, ...(handBack ? { handBack } : {}) }),
    controlState: async () => null,
    macStop: async () => ({ paired: false, online: false }),
    screenshot: async () => ({ data: '', mimeType: 'image/png' }),
    browser: async () => { throw new Error('no browser in this test'); },
    elements: async () => ({ screenId: 'scr-1', width: 1280, height: 800, elements: [] }),
    pasteClipboard: async () => ({ kind: 'image', path: 'Pictures/Pasted/x.png' }),
    copyClipboard: async () => ({ kind: 'empty' }),
    stopProcess: async (_agentId, handle) => ({ handle, state: 'stopped', exitCode: null }),
    pause: async () => undefined,
    resume: async () => undefined,
    computerState: async () => 'none' as const,
    macStatus: async () => ({ paired: false, online: false }),
    macPair: async () => { throw new Error('no Mac in this test'); },
    macRevoke: async () => ({ paired: false, online: false }),
    runtime: async () => ({ kind: 'cloud' as const, image: { state: 'ready' as const } }),
  };
  const enqueuer = { enqueue: async (e: WakeEvent) => { sent.push(e); return { accepted: true }; }, stopRun: async () => undefined, resolveAwakeable: async () => undefined, scheduleRoutine: async () => undefined };
  const app = createTestApp({ store, bus: createMemoryStore().eventBus, enqueuer, computerd });
  const now = AT;
  const agent: Agent & { ownerId: string } = {
    id: 'agent-atlas', name: 'Atlas', handle: 'atlas', avatar: { shape: 'circle', color: 1, eyes: 'dot' },
    title: 't', status: 'idle', section: 'Inbox', pinned: false, lastActivity: '', unreadCount: 0,
    model: { planner: { provider: 'openai', model: 'm' }, computer: { provider: 'openai', model: 'm' }, fast: { provider: 'openai', model: 'm' } },
    channels: [], macAccess: false, skillIds: [], pluginIds: [], sharing: { publishedToTeam: false }, createdBy: OWNER, ownerId: OWNER,
    createdAt: now, updatedAt: now,
  };
  await store.put('agents', agent);
  return { app, store, sent, enqueuer };
}

const auth = { ...ownerHeaders(getConfig().OWNER_ID), 'content-type': 'application/json' };
const seedRun = (store: Store, r: Run) => store.put('runs', r, { agentId: r.agentId, conversationId: r.conversationId ?? '', status: r.status });

describe('screen control notes', () => {
  let h: Awaited<ReturnType<typeof build>>;

  describe('takeover', () => {
    beforeEach(async () => { h = await build(undefined); });

    it('sends nothing when no run is live', async () => {
      await seedRun(h.store, run('run-1', 'completed', AT));
      await h.app.request('/v1/screens/scr-1/take-over', { method: 'POST', headers: auth });
      expect(h.sent).toHaveLength(0);
    });

    it('steers a live run once, with a wake id fixed by the screen, epoch and conversation', async () => {
      await seedRun(h.store, run('run-1', 'running'));
      await h.app.request('/v1/screens/scr-1/take-over', { method: 'POST', headers: auth });
      expect(h.sent.map((e) => e.id)).toEqual(['control:screen:scr-1:1:taken:conv-1']);
      expect(h.sent[0]?.payload).toMatchObject({ surface: 'screen', phase: 'start' });
    });

    it('says nothing for a double tap that computerd saw as no change', async () => {
      h = await build(undefined, false);
      await seedRun(h.store, run('run-1', 'running'));
      await h.app.request('/v1/screens/scr-1/take-over', { method: 'POST', headers: auth });
      expect(h.sent).toHaveLength(0);
    });
  });

  describe('hand-back', () => {
    const back: HandBack = { heldMs: 92_000, changes: ['tab t1 now https://mail.test/ (title "Inbox")'], blocked: false };

    it('steers a live run with the change note and never resumes it', async () => {
      h = await build(back);
      await seedRun(h.store, run('run-1', 'running'));
      await h.app.request('/v1/screens/scr-1/return-control', { method: 'POST', headers: auth });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.payload).toMatchObject({ phase: 'end', heldMs: 92_000, changes: back.changes });
      expect(h.sent[0]?.payload).not.toHaveProperty('resume');
    });

    it('leaves a note for an idle conversation without asking for a run', async () => {
      h = await build(back);
      await seedRun(h.store, run('run-1', 'completed', new Date(Date.now() - 3_600_000).toISOString()));
      await h.app.request('/v1/screens/scr-1/return-control', { method: 'POST', headers: auth });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]?.payload).not.toHaveProperty('resume');
    });

    it('continues a run the takeover held up and that then ended', async () => {
      h = await build({ ...back, blocked: true });
      await seedRun(h.store, run('run-1', 'completed', new Date().toISOString()));
      await h.app.request('/v1/screens/scr-1/return-control', { method: 'POST', headers: auth });
      expect(h.sent[0]?.payload).toMatchObject({ resume: true });
    });

    it('finds the live run among a long history', async () => {
      h = await build(back);
      for (let i = 0; i < 60; i += 1) await seedRun(h.store, { ...run(`old-${i}`, 'completed', AT), conversationId: `old-conv-${i}`, startedAt: new Date(Date.now() - (100 + i) * 3_600_000).toISOString() });
      await seedRun(h.store, run('run-live', 'running'));
      await h.app.request('/v1/screens/scr-1/return-control', { method: 'POST', headers: auth });
      expect(h.sent.map((e) => e.conversationId)).toEqual(['conv-1']);
    });

    it('says nothing when control did not move (no hand-back from computerd)', async () => {
      h = await build(undefined);
      await seedRun(h.store, run('run-1', 'running'));
      await h.app.request('/v1/screens/scr-1/return-control', { method: 'POST', headers: auth });
      expect(h.sent).toHaveLength(0);
    });
  });

  describe('the control.changed event', () => {
    const back: HandBack = { heldMs: 5_000, changes: [], blocked: false };
    type Listener = (stored: { event: AgentEvent }) => void;
    const changed = (phase: 'returned' | 'stopped' | 'resumed', surface: SurfaceRef, epoch: number, agentId?: string): AgentEvent => ({
      type: 'control.changed', ownerId: OWNER, surface, ...(agentId ? { agentId } : {}), holder: phase === 'stopped' ? 'stopped' : 'agent', epoch, since: AT, phase,
    });

    async function listen(computerd: Pick<ComputerdClient, 'controlState'>) {
      h = await build(back);
      const listeners: Listener[] = [];
      await startControlNotices({ deps: { store: h.store, enqueuer: h.enqueuer }, bus: { subscribe: async (l) => { listeners.push(l); return () => undefined; } }, computerd });
      const deliver = async (event: AgentEvent) => { for (const l of listeners) l({ event }); await new Promise((r) => setTimeout(r, 20)); };
      return { deliver };
    }

    it('a change announced by the route and again by its event reaches the run as one wake', async () => {
      const state = (epoch: number): ControlState => ({
        id: 'screen:scr-1', ownerId: OWNER, surface: { kind: 'screen', screenId: 'scr-1' }, holder: 'agent', epoch, since: AT, resumeSnapshotRequired: true,
        capabilities: { take: true, stop: false, resumeRemote: true }, handBack: back,
      });
      const { deliver } = await listen({ controlState: async () => state(2) });
      await seedRun(h.store, run('run-1', 'running'));
      await h.app.request('/v1/screens/scr-1/return-control', { method: 'POST', headers: auth });
      const event = changed('returned', { kind: 'screen', screenId: 'scr-1' }, 2, 'agent-atlas');
      await deliver(event);
      await deliver(event);
      expect(h.sent.length).toBeGreaterThan(1);
      // The runner's enqueue dedupes by wake id: however many deliveries, they are the same wake.
      expect(new Set(h.sent.map((e) => e.id))).toEqual(new Set(['control:screen:scr-1:2:returned:conv-1']));
    });

    it('a Mac Stop (no agentd route) steers the live runs of agents that may use the Mac; the resume carries what Stop cancelled', async () => {
      const mac: SurfaceRef = { kind: 'mac', macId: 'mac-abcdefgh' };
      const { deliver } = await listen({ controlState: async () => ({
        id: 'mac:mac-abcdefgh', ownerId: OWNER, surface: mac, holder: 'agent', epoch: 2, since: AT, resumeSnapshotRequired: true,
        capabilities: { take: false, stop: true, resumeRemote: false }, handBack: { heldMs: 7_000, changes: [], blocked: false, cancelled: ['npm test'] },
      }) });
      await h.store.patch('agents', 'agent-atlas', { macAccess: true });
      await seedRun(h.store, run('run-1', 'running'));
      await deliver(changed('stopped', mac, 1));
      expect(h.sent.at(-1)).toMatchObject({ id: 'control:mac:mac-abcdefgh:1:stopped:conv-1', payload: { surface: 'mac', phase: 'start' } });
      await deliver(changed('resumed', mac, 2));
      expect(h.sent.at(-1)).toMatchObject({ id: 'control:mac:mac-abcdefgh:2:resumed:conv-1', payload: { surface: 'mac', phase: 'end', heldMs: 7_000, cancelled: ['npm test'] } });
    });
  });
});
