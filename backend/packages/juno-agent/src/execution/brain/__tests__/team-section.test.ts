import { describe, expect, it } from 'vitest';
import type { Store, WakeEvent } from '../../../contracts/index.js';
import { createMemoryStore } from '../../../testing/store.js';
import { buildTeamSection } from '../social-context.js';

/** The team section (BACKEND 6.1a): fixed text, changing only when the roster does; owner runs get ids and handles, others names and roles. */

const OWNER = 'owner-team';
const NOW = '2026-10-26T00:00:00.000Z';

type Row = Record<string, unknown> & { id: string };

async function putAgent(store: Store, row: Row): Promise<void> {
  await store.put('agents', { createdAt: NOW, updatedAt: NOW, ownerId: OWNER, ...row } as never);
}

function wakeFor(agentId: string, conversationId: string): WakeEvent {
  return {
    id: 'wke-team', ownerId: OWNER, agentId, sessionKey: agentId + ':' + conversationId, conversationId,
    kind: 'user_message', origin: { type: 'user', id: OWNER }, trusted: true, priority: 'user', payload: { text: 'hi' }, at: NOW, status: 'accepted',
  } as WakeEvent;
}

async function teamText(store: Store, ownerOnly = true): Promise<string> {
  return buildTeamSection(store, { agentId: 'agt-atlas', conversationId: 'conv-app', sessionKey: 'agt-atlas:conv-app', wake: [wakeFor('agt-atlas', 'conv-app')], ownerOnly });
}

async function fixture(): Promise<Store> {
  const store = createMemoryStore();
  await putAgent(store, { id: 'agt-atlas', name: 'Atlas', handle: 'atlas', title: 'Travel', description: 'Plans trips and flights.' });
  await putAgent(store, { id: 'agt-mint', name: 'Mint', handle: 'mint', title: 'Diet planner', description: 'Plans meals and tracks nutrition.\nSecond line that is not shown.' });
  return store;
}

describe('team section', () => {
  it('is stable across what a teammate is doing right now', async () => {
    const store = await fixture();
    const before = await teamText(store);
    expect(before).toContain('Mint');
    // A running run of the teammate is live status: the team section never reads it.
    await store.put('runs', { id: 'run-mint-1', agentId: 'agt-mint', conversationId: 'conv-mint', status: 'running', title: 'Plan the week', steps: [], lastActivityAt: NOW, at: NOW } as never);
    expect(await teamText(store)).toBe(before);
    expect(before).not.toContain('running');
    expect(before).not.toContain('Plan the week');
  });

  it('changes when a teammate is renamed', async () => {
    const store = await fixture();
    const before = await teamText(store);
    await putAgent(store, { id: 'agt-mint', name: 'Nutri', handle: 'mint', title: 'Diet planner', description: 'Plans meals and tracks nutrition.' });
    const after = await teamText(store);
    expect(after).not.toBe(before);
    expect(after).toContain('Nutri');
    expect(after).not.toContain('"Mint"');
  });

  it('changes when a teammate gets a new role, and when one is added', async () => {
    const store = await fixture();
    const before = await teamText(store);
    await putAgent(store, { id: 'agt-mint', name: 'Mint', handle: 'mint', title: 'Diet coach', description: 'Plans meals and tracks nutrition.' });
    const roled = await teamText(store);
    expect(roled).toContain('Diet coach');
    expect(roled).not.toBe(before);
    await putAgent(store, { id: 'agt-sol', name: 'Sol', handle: 'sol', title: 'Finance' });
    expect(await teamText(store)).toContain('Sol');
  });

  it('lists the owner\'s other agents only, sorted by name, never the agent itself or another owner\'s', async () => {
    const store = await fixture();
    // "Bea" sorts before "Mint" by name, although its id sorts after agt-mint: the order follows the name.
    await putAgent(store, { id: 'agt-zz', name: 'Bea', handle: 'bea', title: 'Cook' });
    await putAgent(store, { id: 'agt-other', name: 'Zed', handle: 'zed', title: 'Foreign', ownerId: 'owner-other' });
    const text = await teamText(store);
    expect(text).not.toContain('Zed');
    expect(text).not.toContain('"Atlas"');
    expect(text.indexOf('"Bea"')).toBeGreaterThan(-1);
    expect(text.indexOf('"Bea"')).toBeLessThan(text.indexOf('"Mint"'));
  });

  it('owner-only runs get ids, handles and what each teammate handles, with the rule to hand work over', async () => {
    const text = await teamText(await fixture(), true);
    expect(text).toContain('agt-mint');
    expect(text).toContain('@mint');
    expect(text).toContain('handles "Plans meals and tracks nutrition."');
    expect(text).not.toContain('Second line');
    expect(text).toContain('hand it to that teammate (handoff, by its id)');
  });

  it('group and stranger runs see names and roles only: no ids, no handles, no descriptions, no hand-over rule', async () => {
    const text = await teamText(await fixture(), false);
    expect(text).toContain('"Mint", role "Diet planner"');
    expect(text).not.toContain('Atlas');
    expect(text).not.toContain('agt-mint');
    expect(text).not.toContain('@mint');
    expect(text).not.toContain('Plans meals');
    expect(text).not.toContain('hand it to that teammate');
  });

  it('is withheld as unavailable when the run\'s owner cannot be established', async () => {
    const store = await fixture();
    const text = await buildTeamSection(store, { agentId: 'agt-atlas', conversationId: 'conv-app', sessionKey: 'agt-atlas:conv-app', wake: [], ownerOnly: true });
    expect(text).toContain('Directory unavailable');
    expect(text).not.toContain('Mint');
  });
});
