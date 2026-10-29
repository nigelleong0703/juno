/**
 * Decision approvals on the API (BACKEND 8.0/8.1): delegations (create / update / revoke, never for the categories that are
 * asked every time), "allow this kind" on an approval, the retired per-tool "always", the sent-back outcome and the history
 * filters. Drives the production app assembly.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStore, NoopEnqueuer } from '@agent-desktop/db';
import type { Store, StoredRequest } from '@agent-desktop/contracts';
import type { DecisionBrief, DecisionCategory, DelegationOffer, Request, Rule } from '@agent-desktop/public-contracts';
import { createTestApp, requestAs } from '../../__tests__/test-app.js';

const A = 'owner-a';
const B = 'owner-b';
const AT = '2026-10-16T00:00:00.000Z';

const stripe = { kind: 'connector', catalogId: 'stripe' } as const;
const spendingLimits = { perPurchase: { amount: '50', currency: 'USD' }, perMonth: { amount: '200', currency: 'USD' } };

function briefFor(categories: DecisionCategory[]): DecisionBrief {
  return {
    sentence: 'Pay the Acme invoice', sentenceSource: 'agent', categories, primary: categories[0],
    platform: { kind: 'connector', name: 'Stripe', catalogId: 'stripe' },
    facts: { money: { amount: '30.00', currency: 'USD', source: 'verified' } },
    binding: { argsHash: 'a', contentDigest: 'c', factsHash: 'f' },
  };
}

function approval(id: string, categories: DecisionCategory[], offer?: DelegationOffer, extra: Partial<StoredRequest> = {}): StoredRequest {
  return {
    id, kind: 'approval', status: 'pending', title: 'Pay the Acme invoice', summary: 'Stripe actions ask first', agentId: 'agent-a', createdAt: new Date().toISOString(),
    payload: { kind: 'approval', action: 'pay', why: 'asked', brief: briefFor(categories), ...(offer === undefined ? {} : { delegationOffer: offer }) },
    ...extra,
  };
}

const spendingOffer: DelegationOffer = { delegable: true, suggested: [{ category: 'spending', platform: stripe, limits: { ...spendingLimits, allowRecurring: false } }] };
const neverOffer: DelegationOffer = { delegable: false, reason: 'irreversible is asked every time and cannot be allowed in advance', suggested: [] };

async function build() {
  const mem = createMemoryStore();
  const app = createTestApp({ store: mem, bus: mem.eventBus, enqueuer: new NoopEnqueuer() });
  const own = mem.forOwner?.(A) as Store;
  await own.put('agents', { id: 'agent-a', name: 'Atlas' } as never);
  await own.put('requests', approval('req-spend', ['spending'], spendingOffer));
  await own.put('requests', approval('req-delete', ['irreversible'], neverOffer));
  await own.put('requests', { ...approval('req-nobrief', ['spending']), payload: { kind: 'approval', action: 'pay', why: 'asked' } });
  return { app, own };
}

const send = (app: ReturnType<typeof createTestApp>, owner: string, path: string, body: unknown, method = 'POST') => requestAs(app, owner, path, { method, body });
const rules = async (res: Response) => ((await res.json()) as { items: Rule[] }).items;

describe('delegations', () => {
  it('creates one with a generated description and a lifetime, and the same cell again updates its limits', async () => {
    const { app } = await build();
    const created = await send(app, A, '/v1/delegations', { agentId: 'agent-a', category: 'spending', platform: stripe, limits: spendingLimits });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as Rule;
    expect(rule).toMatchObject({ scope: 'delegation', behavior: 'auto', enabled: true, agentId: 'agent-a', useCount: 0, delegation: { category: 'spending', platformKey: 'app:stripe' } });
    expect(rule.description).toContain('Stripe');
    expect(Date.parse(rule.expiresAt ?? '')).toBeGreaterThan(Date.now() + 80 * 24 * 3600 * 1000);

    const again = await send(app, A, '/v1/delegations', { agentId: 'agent-a', category: 'spending', platform: stripe, limits: { perPurchase: { amount: '80', currency: 'USD' }, perMonth: { amount: '300', currency: 'USD' } } });
    expect(((await again.json()) as Rule).id).toBe(rule.id);
    const listed = await rules(await requestAs(app, A, '/v1/delegations?agentId=agent-a'));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.delegation?.limits.perPurchase?.amount).toBe('80');
  });

  it('refuses the categories that are asked every time, and limits a category cannot do without', async () => {
    const { app } = await build();
    for (const category of ['irreversible', 'sensitive', 'setup', 'choice']) {
      const res = await send(app, A, '/v1/delegations', { agentId: 'agent-a', category, platform: stripe, limits: {} });
      expect(res.status, category).toBe(400);
    }
    expect((await send(app, A, '/v1/delegations', { agentId: 'agent-a', category: 'spending', platform: stripe, limits: { perPurchase: spendingLimits.perPurchase } })).status).toBe(400);
    expect((await send(app, A, '/v1/delegations', { agentId: 'agent-a', category: 'public', platform: { kind: 'site', host: 'instagram.com' }, limits: { maxPerDay: 3 } })).status).toBe(400);
    expect((await send(app, A, '/v1/delegations', { agentId: 'agent-a', category: 'speaking', platform: { kind: 'connector' }, limits: {} })).status).toBe(400);
    expect((await send(app, A, '/v1/delegations', { agentId: 'agent-none', category: 'speaking', platform: { kind: 'connector', catalogId: 'gmail' }, limits: {} })).status).toBe(404);
    expect(await rules(await requestAs(app, A, '/v1/delegations'))).toEqual([]);
  });

  it('is changed and revoked only through its own routes, and only by its owner', async () => {
    const { app } = await build();
    const rule = (await (await send(app, A, '/v1/delegations', { agentId: 'agent-a', category: 'speaking', platform: { kind: 'connector', catalogId: 'gmail' }, limits: { replyOnly: true, maxPerDay: 20 } })).json()) as Rule;
    expect(rule.description).toContain('replies only');

    const updated = (await (await send(app, A, `/v1/delegations/${rule.id}`, { limits: { maxPerDay: 5 }, enabled: false }, 'PATCH')).json()) as Rule;
    expect(updated).toMatchObject({ enabled: false, delegation: { limits: { maxPerDay: 5 } } });
    expect((await send(app, A, `/v1/delegations/${rule.id}`, { limits: { perPurchase: { amount: 'x' } } }, 'PATCH')).status).toBe(400);

    expect((await requestAs(app, B, `/v1/delegations/${rule.id}`, { method: 'DELETE' })).status).toBe(404);
    expect(await rules(await requestAs(app, B, '/v1/delegations'))).toEqual([]);
    expect((await requestAs(app, A, `/v1/delegations/${rule.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await rules(await requestAs(app, A, '/v1/delegations'))).toEqual([]);
    // The generic rule routes never write a delegation.
    expect((await send(app, A, '/v1/rules', { description: 'x', scope: 'delegation', behavior: 'auto', enabled: true })).status).toBe(400);
  });
});

describe('allow this kind on an approval', () => {
  it('approves the request and creates the offered delegation; the per-tool "always" is retired', async () => {
    const { app, own } = await build();
    const always = await send(app, A, '/v1/requests/req-spend/resolve', { action: 'approve', scope: 'always' });
    expect(always.status).toBe(400);
    expect((await own.get('requests', 'req-spend'))?.status).toBe('pending');
    expect(await rules(await requestAs(app, A, '/v1/rules'))).toEqual([]);

    const res = await send(app, A, '/v1/requests/req-spend/resolve', { action: 'approve', scope: 'delegate' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'approved', decision: { scope: 'delegate', mode: 'manual' }, outcome: 'allowed_once' });
    const [rule] = await rules(await requestAs(app, A, '/v1/delegations?agentId=agent-a'));
    expect(rule).toMatchObject({ delegation: { category: 'spending', platformKey: 'app:stripe', limits: { perMonth: { amount: '200' } } } });
  });

  it('takes the owner\'s edited limits, and refuses what cannot be allowed in advance', async () => {
    const { app, own } = await build();
    const edited = { category: 'spending', platform: stripe, limits: { perPurchase: { amount: '40', currency: 'USD' }, perMonth: { amount: '90', currency: 'USD' } } };
    expect((await send(app, A, '/v1/requests/req-spend/resolve', { action: 'approve', scope: 'delegate', delegations: [edited] })).status).toBe(200);
    expect((await rules(await requestAs(app, A, '/v1/delegations')))[0]?.delegation?.limits.perMonth?.amount).toBe('90');

    for (const id of ['req-delete', 'req-nobrief']) {
      expect((await send(app, A, `/v1/requests/${id}/resolve`, { action: 'approve', scope: 'delegate' })).status, id).toBe(400);
      expect((await own.get('requests', id))?.status).toBe('pending');
    }
    // A delegation for another app than the one on the card is not "this kind".
    await own.put('requests', approval('req-other', ['spending'], spendingOffer));
    const wrong = { ...edited, platform: { kind: 'connector', catalogId: 'gmail' } };
    expect((await send(app, A, '/v1/requests/req-other/resolve', { action: 'approve', scope: 'delegate', delegations: [wrong] })).status).toBe(400);
    // Deny cannot carry a delegation.
    expect((await send(app, A, '/v1/requests/req-other/resolve', { action: 'deny', scope: 'delegate' })).status).toBe(400);
  });
});

describe('sharing a chat\'s files (a stranger asked in another chat)', () => {
  const chat = { kind: 'chat', conversationId: 'cvn-work', title: 'Work group' } as const;
  const sharingOffer: DelegationOffer = { delegable: true, suggested: [{ category: 'sharing', platform: chat, limits: { recipients: ['cvn-friends'] } }] };
  const privateOffer: DelegationOffer = { delegable: false, reason: 'private files', suggested: [] };
  const sharingCard = (id: string, offer: DelegationOffer, categories: DecisionCategory[] = ['sharing']): StoredRequest => ({
    ...approval(id, categories, offer),
    payload: { kind: 'approval', action: 'read a file', why: 'Bob asked in #general: read a file from "Work group"', brief: { ...briefFor(categories), platform: { kind: 'juno', name: 'Work group' }, facts: {} }, delegationOffer: offer },
  });

  it('approving with "allow this kind" creates the sharing delegation for 90 days, and the same card again keeps one rule', async () => {
    const { app, own } = await build();
    await own.put('requests', sharingCard('req-share', sharingOffer));
    const res = await send(app, A, '/v1/requests/req-share/resolve', { action: 'approve', scope: 'delegate' });
    expect(res.status).toBe(200);
    const [rule] = await rules(await requestAs(app, A, '/v1/delegations?agentId=agent-a'));
    expect(rule).toMatchObject({
      scope: 'delegation', enabled: true, agentId: 'agent-a', useCount: 0,
      delegation: { category: 'sharing', platformKey: 'chat:cvn-work', limits: { recipients: ['cvn-friends'] } },
      description: 'Share files from "Work group" (shown in 1 chat)',
    });
    const days = (Date.parse(rule?.expiresAt ?? '') - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);

    // Another target chat for the same source: the owner's edited list replaces the limits of the one rule.
    await own.put('requests', sharingCard('req-share-2', sharingOffer));
    const both = { ...sharingOffer.suggested[0]!, limits: { recipients: ['cvn-friends', 'cvn-family'] } };
    expect((await send(app, A, '/v1/requests/req-share-2/resolve', { action: 'approve', scope: 'delegate', delegations: [both] })).status).toBe(200);
    const listed = await rules(await requestAs(app, A, '/v1/delegations?agentId=agent-a'));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.delegation?.limits.recipients).toEqual(['cvn-friends', 'cvn-family']);
  });

  it('a private-files card cannot be turned into a delegation, and neither can a delegation for another kind or a chat without recipients', async () => {
    const { app, own } = await build();
    await own.put('requests', sharingCard('req-private', privateOffer, ['sensitive']));
    expect((await send(app, A, '/v1/requests/req-private/resolve', { action: 'approve', scope: 'delegate' })).status).toBe(400);
    expect((await own.get('requests', 'req-private'))?.status).toBe('pending');
    await own.put('requests', sharingCard('req-share', sharingOffer));
    const noRecipients = { category: 'sharing', platform: chat, limits: {} };
    expect((await send(app, A, '/v1/requests/req-share/resolve', { action: 'approve', scope: 'delegate', delegations: [noRecipients] })).status).toBe(400);
    const speaking = { category: 'speaking', platform: chat, limits: {} };
    expect((await send(app, A, '/v1/requests/req-share/resolve', { action: 'approve', scope: 'delegate', delegations: [speaking] })).status).toBe(400);
    expect(await rules(await requestAs(app, A, '/v1/delegations'))).toEqual([]);
  });

  it('is created and changed through /v1/delegations, keeping the chat\'s title, and the owner can revoke it', async () => {
    const { app, own } = await build();
    await own.put('conversations', { id: 'cvn-work', kind: 'room', title: 'Work group', agentIds: ['agent-a'], memberIds: [A], unreadCount: 0, lastItemAt: AT, createdAt: AT } as never);
    const created = await send(app, A, '/v1/delegations', { agentId: 'agent-a', category: 'sharing', platform: chat, limits: { recipients: ['cvn-friends'] } });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as Rule;
    expect(rule.description).toBe('Share files from "Work group" (shown in 1 chat)');
    expect((await send(app, A, '/v1/delegations', { agentId: 'agent-a', category: 'sharing', platform: chat, limits: {} })).status).toBe(400);
    expect((await send(app, A, '/v1/delegations', { agentId: 'agent-a', category: 'speaking', platform: chat, limits: {} })).status).toBe(400);
    const patched = (await (await send(app, A, `/v1/delegations/${rule.id}`, { limits: { recipients: ['cvn-friends', 'cvn-family'], maxPerDay: 10 } }, 'PATCH')).json()) as Rule;
    expect(patched).toMatchObject({ delegation: { platformKey: 'chat:cvn-work', limits: { recipients: ['cvn-friends', 'cvn-family'], maxPerDay: 10 } }, description: 'Share files from "Work group" (shown in 2 chats, at most 10 a day)' });
    expect((await send(app, A, `/v1/delegations/${rule.id}`, { limits: { maxPerDay: 3 } }, 'PATCH')).status).toBe(400);
    expect((await requestAs(app, A, `/v1/delegations/${rule.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await rules(await requestAs(app, A, '/v1/delegations'))).toEqual([]);
  });
});

describe('outcome words and history filters', () => {
  it('sent back to change is its own outcome and the note is kept', async () => {
    const { app } = await build();
    const res = await send(app, A, '/v1/requests/req-spend/resolve', { action: 'deny', reason: 'revise', note: 'Use the company card' });
    expect(await res.json()).toMatchObject({ status: 'denied', decision: { reason: 'revise', note: 'Use the company card' }, outcome: 'revised' });
    const plain = await send(app, A, '/v1/requests/req-delete/resolve', { action: 'deny' });
    expect(((await plain.json()) as Request).outcome).toBe('denied');
  });

  it('filters the history by category and by how it ended', async () => {
    const { app, own } = await build();
    await own.put('requests', approval('req-auto', ['speaking'], undefined, { status: 'approved', resolvedAt: AT, triggeringRuleId: 'rul-1', decision: { by: 'auto', at: AT, mode: 'auto', scope: 'always' } }));
    await send(app, A, '/v1/requests/req-spend/resolve', { action: 'approve' });
    const ids = async (query: string) => ((await (await requestAs(app, A, '/v1/requests?status=resolved&' + query)).json()) as { items: Request[] }).items.map((r) => r.id).sort();
    expect(await ids('category=speaking')).toEqual(['req-auto']);
    expect(await ids('outcome=allowed_rule')).toEqual(['req-auto']);
    expect(await ids('outcome=allowed_once')).toEqual(['req-spend']);
    expect(await ids('category=spending&outcome=allowed_once')).toEqual(['req-spend']);
    expect((await requestAs(app, A, '/v1/requests?status=resolved&category=nonsense')).status).toBe(400);
  });
});
