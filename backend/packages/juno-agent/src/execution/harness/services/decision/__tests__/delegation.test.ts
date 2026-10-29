/**
 * Delegated authority (BACKEND 8.0): a delegation lets one agent decide a kind of thing alone, within limits, and matches only
 * on facts the server verified. Pure matching: the rules, the month's usage and the wake are passed in.
 */
import { describe, expect, it } from 'vitest';
import type { WakeEvent } from '../../../../../contracts/index.js';
import type { DelegationLimits, Rule } from '@agent-desktop/public-contracts';
import type { ToolOrigin } from '../../../../../contracts/index.js';
import { buildDelegationOffer, describeDelegation, matchDelegation, platformKeyOfDelegation, readDelegationUsage, type DelegationUsage } from '../delegation.js';
import { deriveDecision, type Derived } from '../derive.js';
import { createMemoryStore } from '../../../../../testing/store.js';

const AGENT = 'agent-1';
const NOW = new Date('2026-10-16T07:30:00.000Z');

function derive(catalogId: string, toolName: string, args: Record<string, unknown>, sentence: string | null = 'Do it'): Derived {
  const origin: ToolOrigin = { connectionId: 'c1', connectionName: catalogId, toolName, access: 'action', catalogId };
  return deriveDecision({ toolName: `mcp.x.${toolName}_1`, args: { ...args, ...(sentence === null ? {} : { approval: { sentence } }) }, origin });
}

function delegation(category: NonNullable<Rule['delegation']>['category'], platformKey: string, limits: DelegationLimits, extra: Partial<Rule> & { routineId?: string } = {}): Rule {
  const { routineId, ...rule } = extra;
  return {
    id: `rul-${category}-${platformKey}`, description: 'd', scope: 'delegation', behavior: 'auto', source: 'user', enabled: true, agentId: AGENT, createdAt: '2026-10-01T00:00:00.000Z',
    delegation: { category, platformKey, ...(routineId === undefined ? {} : { routineId }), limits },
    expiresAt: '2026-12-01T00:00:00.000Z',
    ...rule,
  };
}

const NO_USAGE: DelegationUsage = { entries: [], complete: true };
function match(derived: Derived, rules: Rule[], usage: DelegationUsage = NO_USAGE, wake?: Partial<WakeEvent>): Rule | undefined {
  return matchDelegation(derived, AGENT, { rules, usage, wake: wake === undefined ? undefined : ({ kind: 'user_message', payload: {}, ...wake } as WakeEvent), now: NOW });
}

const usd = (amount: string) => ({ amount, currency: 'USD' });
const refund = (amount: number, currency = 'usd', sentence: string | null = 'Do it') => derive('stripe', 'charge_card', { amount, currency }, sentence);
const spendingRule = (limits: Partial<DelegationLimits> = {}, extra: Partial<Rule> = {}) => delegation('spending', 'app:stripe', { perPurchase: usd('50'), perMonth: usd('200'), ...limits }, extra);

describe('spending delegation', () => {
  it('allows a verified amount within the per-purchase and per-month limits', () => {
    const rule = spendingRule();
    expect(match(refund(3000), [rule])).toBe(rule);
    expect(match(refund(5000), [rule])).toBe(rule);
    expect(match(refund(5001), [rule])).toBeUndefined();
  });

  it('sums the month\'s approved requests, in the same currency, and does not match when the history is too long to read', () => {
    const rule = spendingRule();
    const usage: DelegationUsage = { complete: true, entries: [{ at: '2026-10-02T00:00:00Z', money: usd('150') }, { at: '2026-10-03T00:00:00Z', money: { amount: '999', currency: 'EUR' } }] };
    expect(match(refund(5000), [rule], usage)).toBe(rule);
    expect(match(refund(5001), [rule], { ...usage, entries: [...usage.entries, { at: '2026-10-04T00:00:00Z', money: usd('0.01') }] })).toBeUndefined();
    expect(match(refund(1000), [rule], { ...usage, complete: false })).toBeUndefined();
  });

  it('asks for another currency and for an amount nobody verified', () => {
    expect(match(refund(1000, 'eur'), [spendingRule()])).toBeUndefined();
    expect(match(derive('stripe', 'charge_card', { amount: 1000 }), [spendingRule()])).toBeUndefined();
    // The agent saying it costs little does not count.
    const declared = derive('stripe', 'charge_card', { approval: { sentence: 'Pay', facts: { money: { amount: '1', currency: 'USD' } } } });
    expect(match(declared, [spendingRule()])).toBeUndefined();
  });

  it('needs the agent\'s own sentence', () => {
    expect(match(refund(1000, 'usd', null), [spendingRule()])).toBeUndefined();
  });
});

describe('what a delegation can never cover', () => {
  it('a refund is also irreversible, so a spending delegation does not let it through', () => {
    const derived = derive('stripe', 'create_refund', { amount: 1000, currency: 'usd' });
    expect(derived.brief.categories).toEqual(['irreversible', 'spending']);
    expect(match(derived, [spendingRule()])).toBeUndefined();
  });

  it('a delegation row with a category that is asked every time never matches, even if one were stored', () => {
    const rule = delegation('irreversible', 'app:google-drive', {});
    expect(match(derive('google-drive', 'delete_file', { file_id: 'f' }), [rule])).toBeUndefined();
  });

  it('every category of the request must be covered', () => {
    const invite = derive('google-calendar', 'create_event', { attendees: ['a@x.com'], start: '2026-10-16T10:00:00+08:00' });
    expect(invite.brief.categories).toEqual(['speaking', 'committing']);
    const speaking = delegation('speaking', 'app:google-calendar', {});
    const committing = delegation('committing', 'app:google-calendar', {});
    expect(match(invite, [speaking])).toBeUndefined();
    expect(match(invite, [speaking, committing])).toBe(speaking);
  });
});

describe('scope of a delegation', () => {
  const reply = (extra: Record<string, unknown> = {}) => derive('gmail', 'reply_to_thread', { to: 'mei@x.com', body: 'ok', ...extra });
  const gmail = (limits: DelegationLimits, extra: Partial<Rule> & { routineId?: string } = {}) => delegation('speaking', 'app:gmail', limits, extra);

  it('belongs to one agent, one platform, and lapses', () => {
    const rule = gmail({});
    expect(match(reply(), [rule])).toBe(rule);
    expect(match(reply(), [{ ...rule, agentId: 'agent-2' }])).toBeUndefined();
    expect(match(reply(), [delegation('speaking', 'app:stripe', {})])).toBeUndefined();
    expect(match(reply(), [{ ...rule, enabled: false }])).toBeUndefined();
    expect(match(reply(), [{ ...rule, expiresAt: '2026-10-16T07:00:00.000Z' }])).toBeUndefined();
  });

  it('replyOnly, a named-recipient list (checked in full) and the daily cap', () => {
    expect(match(reply(), [gmail({ replyOnly: true })])).toBeDefined();
    expect(match(derive('gmail', 'send_email', { to: 'mei@x.com' }), [gmail({ replyOnly: true })])).toBeUndefined();
    expect(match(reply(), [gmail({ recipients: ['Mei@X.com'] })])).toBeDefined();
    expect(match(reply({ to: ['mei@x.com', 'zed@x.com'] }), [gmail({ recipients: ['mei@x.com'] })])).toBeUndefined();
    const many = Array.from({ length: 25 }, (_, i) => `p${i}@x.com`);
    expect(match(reply({ to: many }), [gmail({ recipients: many })])).toBeUndefined();

    const rule = gmail({ maxPerDay: 2 });
    const today = '2026-10-16T01:00:00Z';
    expect(match(reply(), [rule], { complete: true, entries: [{ at: today, ruleId: rule.id }] })).toBe(rule);
    expect(match(reply(), [rule], { complete: true, entries: [{ at: today, ruleId: rule.id }, { at: today, ruleId: rule.id }] })).toBeUndefined();
    expect(match(reply(), [rule], { complete: true, entries: [{ at: '2026-10-15T23:00:00Z', ruleId: rule.id }, { at: '2026-10-15T22:00:00Z', ruleId: rule.id }] })).toBe(rule);
  });

  it('a routine delegation applies only to that routine\'s runs', () => {
    const rule = delegation('public', 'app:linkedin', { maxPerDay: 5 }, { routineId: 'rtn-1' });
    const post = derive('linkedin', 'publish_post', { text: 'news' });
    expect(post.brief.categories).toEqual(['public']);
    expect(match(post, [rule], NO_USAGE, { kind: 'routine', payload: { routineId: 'rtn-1' } })).toBe(rule);
    expect(match(post, [rule], NO_USAGE, { kind: 'routine', payload: { routineId: 'rtn-2' } })).toBeUndefined();
    expect(match(post, [rule], NO_USAGE, { kind: 'user_message' })).toBeUndefined();
    expect(match(post, [rule])).toBeUndefined();
  });
});

describe('committing delegation (accept within working hours)', () => {
  const window = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', tz: 'Asia/Singapore' };
  const accept = (start?: string) => derive('google-calendar', 'respond_to_event', { event_id: 'e', response: 'accepted', ...(start === undefined ? {} : { start }) });
  const rule = delegation('committing', 'app:google-calendar', { acceptOnly: true, window });

  it('matches an invitation inside the window and asks outside it or when the time is not verified', () => {
    expect(match(accept('2026-10-16T15:00:00+08:00'), [rule])).toBe(rule); // Friday 15:00 Singapore
    expect(match(accept('2026-10-18T22:00:00+08:00'), [rule])).toBeUndefined(); // Sunday night
    expect(match(accept('2026-10-16T19:00:00+08:00'), [rule])).toBeUndefined(); // Friday evening
    expect(match(accept('2026-10-16T15:00:00'), [rule])).toBeUndefined(); // no zone: not a verified time
    expect(match(accept(), [rule])).toBeUndefined();
  });

  it('acceptOnly refuses a decline or a new invitation', () => {
    const decline = derive('google-calendar', 'respond_to_event', { event_id: 'e', response: 'declined', start: '2026-10-16T15:00:00+08:00', approval: { sentence: 'Decline' } });
    expect(decline.verb).toBe('decline');
    expect(match(decline, [rule])).toBeUndefined();
  });
});

describe('the offer on an approval card', () => {
  const wake = { kind: 'user_message', payload: {} } as unknown as WakeEvent;

  it('starts spending from the amount rounded up, four times as much a month, no subscriptions', () => {
    const offer = buildDelegationOffer(refund(4800), wake, undefined);
    expect(offer.suggested[0]).toMatchObject({ category: 'spending', platform: { kind: 'connector', catalogId: 'stripe' }, limits: { perPurchase: usd('50'), perMonth: usd('200'), allowRecurring: false } });
  });

  it('starts calendar acceptance in working hours in the owner\'s zone, and a reply as a reply', () => {
    const accept = derive('google-calendar', 'respond_to_event', { event_id: 'e', response: 'accepted' });
    expect(buildDelegationOffer(accept, wake, 'Asia/Singapore').suggested[0]?.limits).toMatchObject({ acceptOnly: true, window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', tz: 'Asia/Singapore' } });
    expect(buildDelegationOffer(derive('gmail', 'reply_to_thread', { to: 'a@x.com' }), wake, undefined).suggested[0]?.limits).toEqual({ replyOnly: true, maxPerDay: 20 });
  });

  it('offers nothing for what is asked every time, an unverified price, a public post outside a routine, or an agent that said nothing', () => {
    expect(buildDelegationOffer(derive('google-drive', 'delete_file', { file_id: 'f' }), wake, undefined)).toMatchObject({ delegable: false, suggested: [] });
    expect(buildDelegationOffer(derive('stripe', 'charge_card', { amount: 100 }), wake, undefined)).toMatchObject({ delegable: false });
    expect(buildDelegationOffer(derive('linkedin', 'publish_post', { text: 'x' }), wake, undefined)).toMatchObject({ delegable: false });
    const routine = { kind: 'routine', payload: { routineId: 'rtn-1' } } as unknown as WakeEvent;
    expect(buildDelegationOffer(derive('linkedin', 'publish_post', { text: 'x' }), routine, undefined).suggested[0]).toMatchObject({ category: 'public', routineId: 'rtn-1' });
    expect(buildDelegationOffer(derive('gmail', 'send_email', { to: 'a@x.com' }, null), wake, undefined).delegable).toBe(false);
  });
});

describe('sharing delegation (a chat\'s files shown in another chat)', () => {
  const WORK = 'cvn-work';
  const share = (path = '/workspace/chats/work-group-00000000/q4.md') => deriveDecision({ toolName: 'files.read', args: { path }, stranger: { kind: 'share', chatId: WORK, title: 'Work group', path } });
  const rule = (recipients: string[], extra: Partial<Rule> = {}) => delegation('sharing', `chat:${WORK}`, { recipients }, extra);
  const friends = { conversationId: 'cvn-friends' };

  it('matches the source chat and the target chat of the run, and is keyed on the source chat', () => {
    expect(share().platformKey).toBe(`chat:${WORK}`);
    expect(share().brief.categories).toEqual(['sharing']);
    const allowed = rule(['cvn-friends', 'cvn-family']);
    expect(match(share(), [allowed], NO_USAGE, friends)).toBe(allowed);
    expect(match(share(), [allowed], NO_USAGE, { conversationId: 'cvn-elsewhere' })).toBeUndefined();
    expect(match(share(), [allowed], NO_USAGE, undefined)).toBeUndefined();
    expect(match(share(), [delegation('sharing', 'chat:cvn-other', { recipients: ['cvn-friends'] })], NO_USAGE, friends)).toBeUndefined();
  });

  it('honours the lifetime, the switch, the agent and maxPerDay like every delegation', () => {
    expect(match(share(), [rule(['cvn-friends'], { expiresAt: '2026-10-01T00:00:00.000Z' })], NO_USAGE, friends)).toBeUndefined();
    expect(match(share(), [rule(['cvn-friends'], { enabled: false })], NO_USAGE, friends)).toBeUndefined();
    expect(match(share(), [rule(['cvn-friends'], { agentId: 'agent-2' })], NO_USAGE, friends)).toBeUndefined();
    const capped = rule(['cvn-friends'], { id: 'rul-share' });
    capped.delegation = { ...capped.delegation!, limits: { recipients: ['cvn-friends'], maxPerDay: 1 } };
    expect(match(share(), [capped], { complete: true, entries: [{ at: NOW.toISOString(), ruleId: 'rul-share' }] }, friends)).toBeUndefined();
  });

  it('is described for the owner by the source chat and how many chats may see it', () => {
    expect(describeDelegation('sharing', { kind: 'chat', conversationId: WORK, title: 'Work group' }, { recipients: ['a'] }, false)).toBe('Share files from "Work group" (shown in 1 chat)');
    expect(describeDelegation('sharing', { kind: 'chat', conversationId: WORK }, { recipients: ['a', 'b'] }, false)).toBe('Share files from a chat (shown in 2 chats)');
    expect(platformKeyOfDelegation({ kind: 'chat', conversationId: WORK, title: 'Work group' })).toBe(`chat:${WORK}`);
  });

  it('is never offered for a connected app\'s action, and the private-files and other-tool cases offer nothing', () => {
    const wake = { kind: 'room_mention', conversationId: 'cvn-friends', agentId: AGENT, payload: {} } as unknown as WakeEvent;
    expect(buildDelegationOffer(share(), wake, undefined).suggested[0]).toEqual({ category: 'sharing', platform: { kind: 'chat', conversationId: WORK, title: 'Work group' }, limits: { recipients: ['cvn-friends'] } });
    expect(buildDelegationOffer(deriveDecision({ toolName: 'files.read', args: { path: '/juno/MEMORY.md' }, stranger: { kind: 'private', path: '/juno/MEMORY.md' } }), wake, undefined)).toEqual({ delegable: false, reason: 'private files', suggested: [] });
    const declared = deriveDecision({ toolName: 'mcp.x.send_1', args: { approval: { sentence: 'Share it', categories: ['sharing'] } }, origin: { connectionId: 'c1', connectionName: 'Gmail', toolName: 'send', access: 'action', catalogId: 'gmail' } });
    expect(buildDelegationOffer(declared, wake, undefined)).toMatchObject({ delegable: false, reason: expect.stringContaining('not from an app') });
  });
});

describe('usage is summed from the approved requests of this month', () => {
  it('reads money and the delegation behind each automatic decision, not older months, other agents or pending ones', async () => {
    const store = createMemoryStore();
    const base = { kind: 'approval' as const, title: 't', summary: 's', createdAt: '2026-10-05T00:00:00.000Z' };
    const payload = (amount: string) => ({ kind: 'approval' as const, action: 'pay', why: 'w', brief: { ...derive('stripe', 'charge_card', { amount: 100, currency: 'usd' }).brief, facts: { money: { amount, currency: 'USD', source: 'verified' as const } } } });
    await store.put('requests', { ...base, id: 'r1', status: 'approved', agentId: AGENT, payload: payload('20') });
    await store.put('requests', { ...base, id: 'r2', status: 'approved', agentId: AGENT, payload: payload('30'), triggeringRuleId: 'rul-1', decision: { by: 'auto', at: base.createdAt, mode: 'auto', scope: 'always' } });
    await store.put('requests', { ...base, id: 'r3', status: 'approved', agentId: AGENT, payload: payload('99'), createdAt: '2026-09-30T00:00:00.000Z' });
    await store.put('requests', { ...base, id: 'r4', status: 'approved', agentId: 'other', payload: payload('77') });
    await store.put('requests', { ...base, id: 'r5', status: 'pending', agentId: AGENT, payload: payload('55') });
    const usage = await readDelegationUsage(store, AGENT, NOW);
    expect(usage.complete).toBe(true);
    expect(usage.entries.map((entry) => [entry.money?.amount, entry.ruleId])).toEqual(expect.arrayContaining([['20', undefined], ['30', 'rul-1']]));
    expect(usage.entries).toHaveLength(2);
  });
});
