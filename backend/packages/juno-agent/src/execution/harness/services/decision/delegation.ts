import { createHash } from 'node:crypto';
import type { Store, WakeEvent } from '../../../../contracts/index.js';
import type { DecisionCategory, DelegationDraft, DelegationLimits, DelegationOffer, DelegationPlatform, Rule } from '@agent-desktop/public-contracts';
import type { Derived } from './derive.js';
import { localClock } from './time.js';

/**
 * Delegated authority (BACKEND 8.0): the owner lets one agent decide a kind of thing alone, within limits, on one platform.
 * A delegation matches a request only when EVERY category of the request is covered by a live one and EVERY limit is met by
 * a `verified` fact (what the agent merely declares never counts). Anything else is asked, exactly as without a delegation.
 */

/** One approved request of this agent, as the limits read them: when, which delegation allowed it, and the money in it. */
export interface UsageEntry {
  at: string;
  ruleId?: string;
  money?: { amount: string; currency: string };
}

export interface DelegationUsage {
  entries: readonly UsageEntry[];
  /** False when the history was too long to read in full: a spending limit cannot be checked then and does not match. */
  complete: boolean;
}

export const NO_USAGE: DelegationUsage = { entries: [], complete: true };

const USAGE_PAGE = 200;
const USAGE_PAGES = 5;

export function monthStartOf(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

const dayStartOf = (now: Date): number => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

/** The agent's approved requests of this calendar month (UTC), newest first; the spend and the per-day counts are summed from them, no counter that could drift. */
export async function readDelegationUsage(store: Store, agentId: string, now: Date): Promise<DelegationUsage> {
  const since = monthStartOf(now);
  const entries: UsageEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < USAGE_PAGES; page += 1) {
    const result = await store.list('requests', { where: { agentId, status: 'approved' }, orderBy: 'at', order: 'desc', limit: USAGE_PAGE, ...(cursor === undefined ? {} : { cursor }) });
    let reachedOlder = false;
    for (const request of result.items) {
      const at = request.resolvedAt ?? request.createdAt;
      if (Date.parse(request.createdAt) < since) reachedOlder = true;
      if (Date.parse(at) < since || request.payload.kind !== 'approval') continue;
      const money = request.payload.brief?.facts.money;
      entries.push({
        at,
        ...(request.decision?.mode === 'auto' && request.triggeringRuleId !== undefined ? { ruleId: request.triggeringRuleId } : {}),
        ...(money === undefined ? {} : { money: { amount: money.amount, currency: money.currency } }),
      });
    }
    if (reachedOlder || result.nextCursor === undefined) return { entries, complete: true };
    cursor = result.nextCursor;
  }
  return { entries, complete: false };
}

const cents = (amount: string): number => Math.round(Number(amount) * 100);

export interface MatchContext {
  rules: readonly Rule[];
  usage: DelegationUsage;
  wake: WakeEvent | undefined;
  now: Date;
}

function routineOf(wake: WakeEvent | undefined): string | undefined {
  const id = wake?.kind === 'routine' ? wake.payload['routineId'] : undefined;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

function withinWindow(window: NonNullable<DelegationLimits['window']>, at: string): boolean {
  const clock = localClock(new Date(at), window.tz);
  const [startHour = 0, startMinute = 0] = window.start.split(':').map(Number);
  const [endHour = 0, endMinute = 0] = window.end.split(':').map(Number);
  return window.days.includes(clock.day) && clock.minutes >= startHour * 60 + startMinute && clock.minutes < endHour * 60 + endMinute;
}

/** Whether one delegation's limits are met by the verified facts of this request. */
function limitsMet(rule: Rule, category: DecisionCategory, derived: Derived, ctx: MatchContext): boolean {
  const limits = rule.delegation?.limits;
  if (limits === undefined) return false;
  const { facts } = derived.brief;
  const todayCount = (): number => ctx.usage.entries.filter((entry) => entry.ruleId === rule.id && Date.parse(entry.at) >= dayStartOf(ctx.now)).length;
  if (limits.maxPerDay !== undefined && todayCount() >= limits.maxPerDay) return false;
  if (category === 'spending') {
    const money = facts.money;
    if (money?.source !== 'verified' || limits.perPurchase === undefined || limits.perMonth === undefined || !ctx.usage.complete) return false;
    if (money.currency !== limits.perPurchase.currency || money.currency !== limits.perMonth.currency) return false;
    if (money.recurring !== undefined && limits.allowRecurring !== true) return false;
    if (limits.merchants !== undefined && limits.merchants.length > 0 && !limits.merchants.map((m) => m.toLowerCase()).includes((money.merchant ?? '').toLowerCase())) return false;
    const amount = cents(money.amount);
    const spent = ctx.usage.entries.filter((entry) => entry.money?.currency === money.currency).reduce((sum, entry) => sum + cents(entry.money?.amount ?? '0'), 0);
    return amount <= cents(limits.perPurchase.amount) && spent + amount <= cents(limits.perMonth.amount);
  }
  if (category === 'speaking') {
    const audience = facts.audience;
    if (audience?.source !== 'verified' || audience.kind === 'public') return false;
    if (limits.replyOnly === true && derived.verb !== 'reply') return false;
    if (limits.recipients !== undefined && limits.recipients.length > 0) {
      const allowed = new Set(limits.recipients.map((recipient) => recipient.toLowerCase()));
      // A list cut at the cap cannot be checked in full.
      if (audience.recipients.length === 0 || (audience.count ?? 0) > audience.recipients.length) return false;
      return audience.recipients.every((recipient) => allowed.has((recipient.address ?? recipient.name).toLowerCase()));
    }
    return true;
  }
  switch (category) {
    case 'committing': {
      if (limits.acceptOnly === true && derived.verb !== 'accept') return false;
      const window = limits.window;
      if (window === undefined) return true;
      const commitments = facts.commitments ?? [];
      return commitments.length > 0 && commitments.every((commitment) => commitment.source === 'verified' && commitment.at !== undefined && withinWindow(window, commitment.at));
    }
    case 'sharing': {
      // The platform is the source chat (matched on the key); the limit is the chats it may be shown in: the one this run is in.
      const target = ctx.wake?.conversationId;
      return target !== undefined && target !== '' && limits.recipients?.includes(target) === true;
    }
    // public: the platform, the routine and the daily cap above are the whole limit.
    case 'public': return true;
    // Spending and speaking returned above; the rest are never delegated (the contract refuses them), so no rule can match.
    case 'irreversible': case 'sensitive': case 'setup': case 'choice': return false;
  }
}

/**
 * The delegation that lets this request through without asking, or undefined. The request needs the agent's own sentence, and
 * every category must be covered by a live delegation on the same platform whose limits the verified facts meet.
 */
export function matchDelegation(derived: Derived, agentId: string, ctx: MatchContext): Rule | undefined {
  const { brief } = derived;
  if (!derived.delegable.ok || derived.platformKey === undefined || brief.categories.length === 0) return undefined;
  const routine = routineOf(ctx.wake);
  const live = ctx.rules.filter((rule) => {
    const delegation = rule.delegation;
    return rule.scope === 'delegation' && rule.enabled && delegation !== undefined && rule.agentId === agentId
      && delegation.platformKey === derived.platformKey
      && (rule.expiresAt === undefined || Date.parse(rule.expiresAt) > ctx.now.getTime())
      && (delegation.routineId === undefined || delegation.routineId === routine);
  });
  const covering = brief.categories.map((category) => live.find((rule) => rule.delegation?.category === category && limitsMet(rule, category, derived, ctx)));
  if (covering.some((rule) => rule === undefined)) return undefined;
  return covering[0];
}

/** Old per-tool "always" rules and the send tier never let these through: money, deleting for good, secrets. */
export function relaxableByOldRules(derived: Derived): boolean {
  return !derived.brief.categories.some((category) => category === 'spending' || category === 'irreversible' || category === 'sensitive');
}

// --- Offer, id and words ----------------------------------------------------------------------------------------

export function platformKeyOfDelegation(platform: DelegationPlatform): string {
  switch (platform.kind) {
    case 'connector': return `app:${platform.catalogId ?? ''}`;
    case 'site': return `site:${platform.host ?? ''}`;
    case 'chat': return `chat:${platform.conversationId ?? ''}`;
    case 'juno': return 'juno';
  }
}

/** One delegation per agent + category + platform + routine, so asking for the same one again updates its limits. */
export function delegationRuleId(agentId: string, category: DecisionCategory, platformKey: string, routineId: string | undefined): string {
  return 'rul-dlg-' + createHash('sha256').update([agentId, category, platformKey, routineId ?? ''].join('\0')).digest('hex').slice(0, 24);
}

const CATEGORY_WORDS: Record<DecisionCategory, string> = {
  spending: 'Spend money',
  speaking: 'Write to people',
  public: 'Post publicly',
  committing: 'Accept and make commitments',
  irreversible: 'Delete for good',
  sensitive: 'Handle sensitive data',
  sharing: 'Share files',
  setup: 'Change the computer or settings',
  choice: 'Choose',
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function platformName(platform: DelegationPlatform): string {
  switch (platform.kind) {
    case 'site': return platform.host ?? 'a site';
    case 'juno': return 'Juno';
    case 'chat': return platform.title === undefined || platform.title === '' ? 'a chat' : `"${platform.title}"`;
    case 'connector': return (platform.catalogId ?? 'an app').split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  }
}

/** The sentence the owner reads for a delegation: what, where, and the limits. Generated, never typed by the agent. */
export function describeDelegation(category: DecisionCategory, platform: DelegationPlatform, limits: DelegationLimits, hasRoutine: boolean): string {
  const parts: string[] = [];
  if (limits.perPurchase !== undefined) parts.push(`up to ${limits.perPurchase.amount} ${limits.perPurchase.currency} each`);
  if (limits.perMonth !== undefined) parts.push(`${limits.perMonth.amount} ${limits.perMonth.currency} a month`);
  if (limits.allowRecurring === true) parts.push('subscriptions allowed');
  if (limits.replyOnly === true) parts.push('replies only');
  if (limits.recipients !== undefined && limits.recipients.length > 0) {
    const count = limits.recipients.length;
    parts.push(category === 'sharing' ? `shown in ${count} ${count === 1 ? 'chat' : 'chats'}` : `only to ${count} named ${count === 1 ? 'person' : 'people'}`);
  }
  if (limits.acceptOnly === true) parts.push('accepting only');
  if (limits.window !== undefined) {
    const days = [...limits.window.days].sort().map((day) => DAY_NAMES[day]).join(', ');
    parts.push(`${days} ${limits.window.start}-${limits.window.end}`);
  }
  if (limits.maxPerDay !== undefined) parts.push(`at most ${limits.maxPerDay} a day`);
  if (hasRoutine) parts.push('in one routine only');
  return `${CATEGORY_WORDS[category]} ${category === 'sharing' ? 'from' : 'in'} ${platformName(platform)}${parts.length === 0 ? '' : ' (' + parts.join(', ') + ')'}`;
}

const roundUp10 = (amount: string): number => Math.max(10, Math.ceil(Number(amount) / 10) * 10);

/** What "allow this kind" would start with; the owner edits it. Numbers are presets, not rules. */
function suggestedFor(category: DecisionCategory, derived: Derived, platform: DelegationPlatform, routineId: string | undefined, timeZone: string): DelegationDraft | string {
  const base = { category, platform, ...(routineId === undefined ? {} : { routineId }) };
  switch (category) {
    case 'spending': {
      const money = derived.brief.facts.money;
      if (money?.source !== 'verified') return 'The price could not be checked against the real call, so spending cannot be allowed in advance';
      const single = roundUp10(money.amount);
      return { ...base, limits: { perPurchase: { amount: String(single), currency: money.currency }, perMonth: { amount: String(single * 4), currency: money.currency }, allowRecurring: false } };
    }
    case 'speaking': return { ...base, limits: { ...(derived.verb === 'reply' ? { replyOnly: true } : {}), maxPerDay: 20 } };
    case 'committing':
      return { ...base, limits: { ...(derived.verb === 'accept' ? { acceptOnly: true } : {}), window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', tz: timeZone } } };
    case 'public':
      return routineId === undefined ? 'Public posts can only be allowed for one routine, and this is not a routine run' : { ...base, limits: { maxPerDay: 5 } };
    case 'sharing': return 'Files are shared from one chat to another, not from an app';
    case 'irreversible': case 'sensitive': case 'setup': case 'choice': return `${category} is asked every time and cannot be allowed in advance`;
  }
}

/**
 * Sharing a chat's files with the chat this run is in: the delegation the card offers for a stranger-woken run's file call. The
 * chats already allowed to see them stay in the list (asking again for another chat must not narrow what the owner granted).
 */
function sharingOffer(share: NonNullable<Derived['share']>, wake: WakeEvent | undefined, rules: readonly Rule[]): DelegationOffer {
  const target = wake?.conversationId;
  if (target === undefined || target === '') return { delegable: false, reason: 'This chat could not be identified', suggested: [] };
  const existing = rules.find((rule) => rule.id === delegationRuleId(wake?.agentId ?? '', 'sharing', `chat:${share.chatId}`, undefined))?.delegation?.limits.recipients ?? [];
  const recipients = [...new Set([...existing, target])].slice(-50);
  const platform: DelegationPlatform = { kind: 'chat', conversationId: share.chatId, title: share.title.slice(0, 200) };
  return { delegable: true, suggested: [{ category: 'sharing', platform, limits: { recipients } }] };
}

/** The offer on an approval card (BACKEND 8.0): whether "allow this kind" is available and the limits it would start with. */
export function buildDelegationOffer(derived: Derived, wake: WakeEvent | undefined, timeZone: string | undefined, rules: readonly Rule[] = []): DelegationOffer {
  if (!derived.delegable.ok) return { delegable: false, reason: derived.delegable.reason, suggested: [] };
  if (derived.share !== undefined) return sharingOffer(derived.share, wake, rules);
  const catalogId = derived.brief.platform.catalogId;
  const platform: DelegationPlatform = { kind: 'connector', ...(catalogId === undefined ? {} : { catalogId }) };
  const routineId = routineOf(wake);
  const suggested: DelegationDraft[] = [];
  for (const category of derived.brief.categories) {
    const draft = suggestedFor(category, derived, platform, category === 'public' ? routineId : undefined, timeZone ?? 'UTC');
    if (typeof draft === 'string') return { delegable: false, reason: draft, suggested: [] };
    suggested.push(draft);
  }
  return { delegable: true, suggested };
}
