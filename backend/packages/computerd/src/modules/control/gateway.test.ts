/** The control gateway's rules that the end-to-end pins do not cover: stale taps, who may resume a Mac, what a hand-back carries, the audit. */
import { describe, expect, it } from 'vitest';
import { createMemoryStore } from '@agent-desktop/db';
import type { Store, SurfaceRef } from '@agent-desktop/contracts';
import { createControlGateway } from './gateway.js';

const OWNER = 'owner-1';
const mac: SurfaceRef = { kind: 'mac', macId: 'mac-abcdefgh' };
const screen: SurfaceRef = { kind: 'screen', screenId: 'scr-1' };

async function setup() {
  const base = createMemoryStore();
  const store = base.forOwner?.(OWNER) as Store;
  /** The events committed so far, read back from the durable log. */
  const events = async () => (await base.eventBus.since(0)).map((stored) => stored.event);
  await store.put('screens', { id: 'scr-1', ownerId: OWNER, computerId: 'c', agentId: 'agent-a', displayNo: 1, state: 'live', title: 't', resolution: '1x1', lastUsedAt: '', lastVncPort: 5901, lastWebPort: 6081 });
  return { store, events, gateway: createControlGateway({ store, ownerId: OWNER }) };
}

describe('control gateway', () => {
  it('a take-over or hand-back made from a stale epoch changes nothing', async () => {
    const { gateway } = await setup();
    const taken = await gateway.take(screen, { via: 'ios' }, { agentId: 'agent-a', expectEpoch: 0 });
    expect(taken).toMatchObject({ changed: true, state: { holder: 'user', epoch: 1 } });
    // A second client that still shows epoch 0 hands back: refused as stale, the person still holds it.
    expect(await gateway.release(screen, { via: 'web' }, { agentId: 'agent-a', expectEpoch: 0 })).toMatchObject({ changed: false, state: { holder: 'user', epoch: 1 } });
    const released = await gateway.release(screen, { via: 'ios' }, { agentId: 'agent-a', expectEpoch: 1 });
    expect(released).toMatchObject({ changed: true, state: { holder: 'agent', epoch: 2, resumeSnapshotRequired: true }, handBack: { blocked: false } });
  });

  it('writes one audit entry and one event per change, naming the person', async () => {
    const { gateway, store, events } = await setup();
    await gateway.take(screen, { via: 'ios', userId: 'member-1' }, { agentId: 'agent-a' });
    await gateway.take(screen, { via: 'ios', userId: 'member-1' }, { agentId: 'agent-a' });
    const logged = await events();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ type: 'control.changed', ownerId: OWNER, phase: 'taken', epoch: 1, holder: 'user' });
    const audit = await store.list('audit', { limit: 10 });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]).toMatchObject({ actor: 'user', memberId: 'member-1', unattended: false, decision: 'handed_off' });
  });

  it('refuses a screen action that arrives after a hand-back until the agent has looked, and a refusal marks the run as held up', async () => {
    const { gateway } = await setup();
    await gateway.take(screen, { via: 'api' }, { agentId: 'agent-a' });
    await expect(gateway.admit(screen, 'agent-a', { mutation: false })).rejects.toMatchObject({ code: 'user_control', details: { surface: 'screen', holder: 'user' } });
    const { handBack } = await gateway.release(screen, { via: 'api' }, { agentId: 'agent-a' });
    expect(handBack?.blocked).toBe(true);
    await expect(gateway.admit(screen, 'agent-a', { mutation: true })).rejects.toMatchObject({ details: { reason: 'inspect_first' } });
    (await gateway.admit(screen, 'agent-a', { mutation: false, looks: true })).done();
    (await gateway.admit(screen, 'agent-a', { mutation: true })).done();
  });

  it('a Mac can be stopped from anywhere but resumed only on the Mac, and the resume says what Stop cancelled', async () => {
    const { gateway } = await setup();
    await gateway.ensure(mac);
    expect(await gateway.stop(mac, { via: 'ios' })).toMatchObject({ changed: true, state: { holder: 'stopped' } });
    // The Mac then reports what it cancelled; the second stop changes no holder but keeps that list.
    expect(await gateway.stop(mac, { via: 'mac-local' }, { cancelled: ['npm test'] })).toMatchObject({ changed: false });
    await expect(gateway.resume(mac, { via: 'ios' })).rejects.toMatchObject({ code: 'not_allowed' });
    await expect(gateway.admit(mac, undefined, { mutation: false })).rejects.toMatchObject({ details: { surface: 'mac', holder: 'stopped' } });
    const resumed = await gateway.resume(mac, { via: 'mac-local' });
    expect(resumed).toMatchObject({ changed: true, state: { holder: 'agent' }, handBack: { cancelled: ['npm test'] } });
    await expect(gateway.take(mac, { via: 'ios' })).rejects.toMatchObject({ code: 'not_allowed' });
  });
});
