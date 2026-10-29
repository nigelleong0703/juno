import { describe, expect, it } from 'vitest';
import { createDelegationInputSchema, createRuleInputSchema, delegationDraftSchema, deriveRequestOutcome, primaryCategory, type Request } from '../index.js';

const approval = (status: Request['status'], decision?: Partial<NonNullable<Request['decision']>>): Pick<Request, 'status' | 'decision' | 'payload'> => ({
  status,
  payload: { kind: 'approval', action: 'send email', why: 'w' },
  ...(decision === undefined ? {} : { decision: { by: 'o', at: '2026-10-16T00:00:00.000Z', mode: 'manual', scope: 'once', ...decision } }),
});

describe('outcome words', () => {
  it('derive from status and decision, only for decided approvals', () => {
    expect(deriveRequestOutcome(approval('approved', {}))).toBe('allowed_once');
    expect(deriveRequestOutcome(approval('approved', { by: 'auto', mode: 'auto' }))).toBe('allowed_rule');
    expect(deriveRequestOutcome(approval('denied', {}))).toBe('denied');
    expect(deriveRequestOutcome(approval('denied', { reason: 'revise' }))).toBe('revised');
    expect(deriveRequestOutcome(approval('expired'))).toBe('cancelled');
    expect(deriveRequestOutcome(approval('expired', { reason: 'timeout' }))).toBe('timed_out');
    expect(deriveRequestOutcome(approval('pending'))).toBeUndefined();
    expect(deriveRequestOutcome({ status: 'answered', payload: { kind: 'question', ui: { version: 1, blocks: [] } } })).toBeUndefined();
  });
});

describe('delegation input', () => {
  const stripe = { kind: 'connector', catalogId: 'stripe' } as const;
  const spending = { perPurchase: { amount: '50', currency: 'USD' }, perMonth: { amount: '200', currency: 'USD' } };

  it('accepts only the categories that can be delegated, each with the limits it needs', () => {
    expect(delegationDraftSchema.safeParse({ category: 'spending', platform: stripe, limits: spending }).success).toBe(true);
    for (const category of ['irreversible', 'sensitive', 'setup', 'choice']) {
      expect(delegationDraftSchema.safeParse({ category, platform: stripe, limits: {} }).success, category).toBe(false);
    }
    expect(delegationDraftSchema.safeParse({ category: 'spending', platform: stripe, limits: { perPurchase: spending.perPurchase } }).success).toBe(false);
    expect(delegationDraftSchema.safeParse({ category: 'spending', platform: stripe, limits: { perPurchase: spending.perPurchase, perMonth: { amount: '9', currency: 'EUR' } } }).success).toBe(false);
    expect(delegationDraftSchema.safeParse({ category: 'public', platform: { kind: 'site', host: 'x.com' }, limits: {} }).success).toBe(false);
    expect(createDelegationInputSchema.safeParse({ agentId: 'a', category: 'public', platform: { kind: 'site', host: 'x.com' }, routineId: 'r', limits: { maxPerDay: 3 } }).success).toBe(true);
  });

  it('sharing is for one chat and needs the chats it may be shown in; a chat is only the platform of sharing', () => {
    const chat = { kind: 'chat', conversationId: 'cvn-work', title: 'Work group' } as const;
    expect(delegationDraftSchema.safeParse({ category: 'sharing', platform: chat, limits: { recipients: ['cvn-friends'] } }).success).toBe(true);
    expect(createDelegationInputSchema.safeParse({ agentId: 'a', category: 'sharing', platform: chat, limits: { recipients: ['cvn-friends'], maxPerDay: 20 } }).success).toBe(true);
    expect(delegationDraftSchema.safeParse({ category: 'sharing', platform: chat, limits: {} }).success).toBe(false);
    expect(delegationDraftSchema.safeParse({ category: 'sharing', platform: chat, limits: { recipients: [] } }).success).toBe(false);
    expect(delegationDraftSchema.safeParse({ category: 'sharing', platform: stripe, limits: { recipients: ['cvn-friends'] } }).success).toBe(false);
    expect(delegationDraftSchema.safeParse({ category: 'sharing', platform: { kind: 'chat' }, limits: { recipients: ['cvn-friends'] } }).success).toBe(false);
    for (const category of ['speaking', 'spending', 'committing']) {
      expect(delegationDraftSchema.safeParse({ category, platform: chat, limits: { recipients: ['cvn-friends'], ...spending } }).success, category).toBe(false);
    }
    expect(delegationDraftSchema.safeParse({ category: 'public', platform: chat, routineId: 'r', limits: {} }).success).toBe(false);
  });

  it('the rule input never carries a delegation, so the rule routes cannot write one', () => {
    const parsed = createRuleInputSchema.parse({ description: 'd', scope: 'action', behavior: 'ask', enabled: true, delegation: { category: 'spending' }, useCount: 9 });
    expect(parsed).not.toHaveProperty('delegation');
    expect(parsed).not.toHaveProperty('useCount');
  });

  it('the most severe category is the primary', () => {
    expect(primaryCategory(['speaking', 'spending', 'committing'])).toBe('spending');
    expect(primaryCategory(['choice', 'irreversible'])).toBe('irreversible');
    expect(primaryCategory(['public', 'sharing', 'speaking'])).toBe('sharing');
    expect(primaryCategory(['sharing', 'sensitive'])).toBe('sensitive');
    expect(primaryCategory([])).toBeUndefined();
  });
});
