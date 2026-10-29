import { z } from 'zod';

/**
 * Decision approvals (BACKEND 8.1, contracts 0.22.0). An approval is about a decision the agent cannot take alone, so it
 * carries a brief: what the agent wants to do (its own sentence), why, what happens if you say no, and the facts the
 * server worked out from the real call. The agent tells the story, the server states the facts: each fact says which.
 */

/** The kind of decision, a small label on the card, a history row and a filter. Severity order: see `DECISION_CATEGORY_ORDER`. */
export const decisionCategorySchema = z.enum([
  'spending',
  'speaking',
  'public',
  'committing',
  'irreversible',
  'sensitive',
  /** Files of one chat shown in another (contracts 0.47.0). */
  'sharing',
  'setup',
  'choice',
]);
export type DecisionCategory = z.infer<typeof decisionCategorySchema>;

/** Most severe first: the first category of a request that is in this list is its `primary`. */
export const DECISION_CATEGORY_ORDER: readonly DecisionCategory[] = [
  'irreversible',
  'spending',
  'sensitive',
  'sharing',
  'public',
  'speaking',
  'committing',
  'setup',
  'choice',
];

/** Categories the owner can hand to an agent within limits. The others are asked every time, whatever any rule says. */
export const DELEGABLE_CATEGORIES = ['spending', 'speaking', 'public', 'committing', 'sharing'] as const;
export type DelegableCategory = (typeof DELEGABLE_CATEGORIES)[number];

export function isDelegableCategory(category: DecisionCategory): category is DelegableCategory {
  return (DELEGABLE_CATEGORIES as readonly string[]).includes(category);
}

/** The most severe category of a request, or undefined when it has none. */
export function primaryCategory(categories: readonly DecisionCategory[]): DecisionCategory | undefined {
  return DECISION_CATEGORY_ORDER.find((category) => categories.includes(category));
}

/** `verified`: the server got it from the real call arguments, the page, the connection or a table. `declared`: only the agent said so. */
export const factSourceSchema = z.enum(['verified', 'declared']);
export type FactSource = z.infer<typeof factSourceSchema>;

const decimalSchema = z.string().regex(/^\d+(\.\d{1,6})?$/);

export const decisionFactsSchema = z.object({
  money: z
    .object({
      /** Decimal string in major units, e.g. "48.00". */
      amount: decimalSchema,
      /** ISO 4217, e.g. "USD". */
      currency: z.string().min(3).max(8),
      recurring: z.enum(['weekly', 'monthly', 'yearly']).optional(),
      merchant: z.string().max(120).optional(),
      source: factSourceSchema,
    })
    .optional(),
  audience: z
    .object({
      kind: z.enum(['people', 'room', 'team', 'public']),
      count: z.number().int().min(0).optional(),
      recipients: z.array(z.object({ name: z.string().max(160), address: z.string().max(200).optional() })).max(20),
      source: factSourceSchema,
    })
    .optional(),
  /** Acts in your name or on your account, e.g. "you@gmail.com". */
  asAccount: z.object({ label: z.string().max(200), catalogId: z.string().optional(), source: factSourceSchema }).optional(),
  reversible: z.object({ value: z.enum(['yes', 'hard', 'no']), how: z.string().max(160).optional(), source: factSourceSchema }).optional(),
  sensitive: z
    .array(z.object({ kind: z.enum(['credentials', 'payment_card', 'identity', 'private_files', 'secrets']), label: z.string().max(120), source: factSourceSchema }))
    .max(5)
    .optional(),
  /** What is promised in your name. `at` is the ISO time when known. */
  commitments: z
    .array(z.object({ kind: z.enum(['meeting', 'booking', 'promise', 'deadline']), text: z.string().max(200), at: z.string().max(40).optional(), source: factSourceSchema }))
    .max(5)
    .optional(),
  /** What will be changed or deleted. */
  targets: z
    .array(z.object({ kind: z.enum(['file', 'event', 'record', 'package', 'agent']), label: z.string().max(160), count: z.number().int().min(0).optional() }))
    .max(20)
    .optional(),
});
export type DecisionFacts = z.infer<typeof decisionFactsSchema>;

/** Where the action lands: the main icon of the card. `site` carries only the host; the API turns it into a signed `iconUrl`. */
export const decisionPlatformSchema = z.object({
  kind: z.enum(['connector', 'site', 'juno', 'none']),
  name: z.string().min(1).max(120),
  /** Connector catalog id (gmail, google-calendar, ...): the client has a brand icon per id. */
  catalogId: z.string().optional(),
  host: z.string().max(253).optional(),
  account: z.string().max(200).optional(),
  /** Added by the API gateway for `kind: 'site'` (BACKEND 5.13b); never stored. */
  iconUrl: z.string().optional(),
});
export type DecisionPlatform = z.infer<typeof decisionPlatformSchema>;

/** Hashes of exactly what was reviewed. A different call, content or verified fact gives a different hash, so it needs a new approval. */
export const decisionBindingSchema = z.object({
  argsHash: z.string(),
  contentDigest: z.string(),
  factsHash: z.string(),
});
export type DecisionBinding = z.infer<typeof decisionBindingSchema>;

export const decisionBriefSchema = z.object({
  /** One plain sentence of what will happen. The agent's own (`sentenceSource: 'agent'`) or the server's fallback. */
  sentence: z.string().min(1).max(160),
  sentenceSource: z.enum(['agent', 'server']).optional(),
  /** The agent's reason (its words). */
  why: z.string().max(240).optional(),
  /** What the agent does if you refuse (its words). */
  ifDenied: z.string().max(160).optional(),
  /** Derived by the server, plus any the agent declared (it can only make a request stricter). */
  categories: z.array(decisionCategorySchema).max(8),
  primary: decisionCategorySchema.optional(),
  platform: decisionPlatformSchema,
  facts: decisionFactsSchema,
  binding: decisionBindingSchema,
});
export type DecisionBrief = z.infer<typeof decisionBriefSchema>;

/** The words of how a decided approval ended; derived by the server (`Request.outcome`), clients only translate. */
export const requestOutcomeSchema = z.enum([
  'allowed_once',
  'allowed_rule',
  'denied',
  'revised',
  'timed_out',
  'cancelled',
  'handed_back',
]);
export type RequestOutcome = z.infer<typeof requestOutcomeSchema>;

// --- Delegated authority ---------------------------------------------------

export const moneyLimitSchema = z.object({ amount: decimalSchema, currency: z.string().min(3).max(8) });
export type MoneyLimit = z.infer<typeof moneyLimitSchema>;

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/**
 * Which part of a platform a delegation covers; a connector needs its catalog id, a site its host, a chat (contracts 0.47.0,
 * only for `sharing`) the conversation whose files are shared and, for display, its title.
 */
export const delegationPlatformSchema = z.object({
  kind: z.enum(['connector', 'site', 'juno', 'chat']),
  catalogId: z.string().min(1).max(80).optional(),
  host: z.string().min(1).max(253).optional(),
  conversationId: z.string().min(1).max(200).optional(),
  title: z.string().max(200).optional(),
});
export type DelegationPlatform = z.infer<typeof delegationPlatformSchema>;

/**
 * Limits per category (only verified facts are checked against them): `spending` perPurchase + perMonth (+ allowRecurring,
 * merchants); `speaking` recipients / replyOnly / maxPerDay; `committing` acceptOnly / window; `public` maxPerDay;
 * `sharing` recipients = the target chats (conversation ids) that may be shown the source chat's files.
 */
export const delegationLimitsSchema = z.object({
  perPurchase: moneyLimitSchema.optional(),
  perMonth: moneyLimitSchema.optional(),
  allowRecurring: z.boolean().optional(),
  merchants: z.array(z.string().min(1).max(120)).max(20).optional(),
  recipients: z.array(z.string().min(1).max(200)).max(50).optional(),
  replyOnly: z.boolean().optional(),
  acceptOnly: z.boolean().optional(),
  window: z
    .object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: timeOfDay, end: timeOfDay, tz: z.string().min(1).max(64) })
    .optional(),
  maxPerDay: z.number().int().min(1).max(500).optional(),
});
export type DelegationLimits = z.infer<typeof delegationLimitsSchema>;

const delegationBase = z.object({
  category: decisionCategorySchema,
  platform: delegationPlatformSchema,
  /** Only valid in this routine's runs; required for `public`. */
  routineId: z.string().min(1).optional(),
  limits: delegationLimitsSchema,
});

function checkDelegation(input: { category: DecisionCategory; platform: DelegationPlatform; routineId?: string | undefined; limits: DelegationLimits }, ctx: z.RefinementCtx): void {
  const fail = (message: string): void => ctx.addIssue({ code: 'custom', message });
  if (!isDelegableCategory(input.category)) fail(`${input.category} is asked every time and cannot be delegated`);
  if (input.platform.kind === 'connector' && input.platform.catalogId === undefined) fail('a connector delegation needs a catalogId');
  if (input.platform.kind === 'site' && input.platform.host === undefined) fail('a site delegation needs a host');
  if (input.platform.kind === 'chat' && input.platform.conversationId === undefined) fail('a chat delegation needs a conversationId');
  if (input.platform.kind === 'chat' && input.category !== 'sharing') fail('a chat can only be the platform of a sharing delegation');
  const { limits } = input;
  if (input.category === 'sharing') {
    if (input.platform.kind !== 'chat') fail('a sharing delegation is for one chat');
    if (limits.recipients === undefined || limits.recipients.length === 0) fail('sharing needs the chats it may be shown in (recipients)');
  }
  if (input.category === 'spending') {
    if (limits.perPurchase === undefined || limits.perMonth === undefined) fail('spending needs perPurchase and perMonth limits');
    else if (limits.perPurchase.currency !== limits.perMonth.currency) fail('perPurchase and perMonth must use one currency');
  }
  if (input.category === 'public' && input.routineId === undefined) fail('public delegations are limited to one routine');
}

export const delegationDraftSchema = delegationBase.superRefine(checkDelegation);
export type DelegationDraft = z.infer<typeof delegationDraftSchema>;

/** `POST /v1/delegations`: the same agent + category + platform + routine again updates the limits of the existing one. */
export const createDelegationInputSchema = delegationBase.extend({ agentId: z.string().min(1), expiresAt: z.string().optional() }).superRefine(checkDelegation);
export type CreateDelegationInput = z.infer<typeof createDelegationInputSchema>;

export const updateDelegationInputSchema = z.object({
  limits: delegationLimitsSchema.optional(),
  expiresAt: z.string().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateDelegationInput = z.infer<typeof updateDelegationInputSchema>;

/**
 * Server's offer on an approval card: whether "allow this kind" can be offered, and the limits it would start with (presets,
 * the owner changes them). `suggested` has one entry per category of the request, each one is created on `scope: 'delegate'`.
 */
export const delegationOfferSchema = z.object({
  delegable: z.boolean(),
  /** Why not, when `delegable` is false. */
  reason: z.string().max(200).optional(),
  suggested: z.array(delegationDraftSchema).max(4),
});
export type DelegationOffer = z.infer<typeof delegationOfferSchema>;
