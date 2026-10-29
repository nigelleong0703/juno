import { z } from 'zod';
import { idSchema, isoDateSchema, isoDateTimeSchema } from './common.js';
import { ideaSchema } from './idea.js';
import { isInteractiveBlock, uiDocSchema } from './ui.js';

/** A feed post's structured detail: display blocks only (no choices or fields), a post asks for nothing. */
export const feedUiDocSchema = uiDocSchema.refine((doc) => !doc.blocks.some(isInteractiveBlock), { message: 'a feed post shows information only: no choices or fields blocks' });

export const feedbackSignalSchema = z.enum(['more', 'less']);
export type FeedbackSignal = z.infer<typeof feedbackSignalSchema>;

/** Why the owner wants less: wrong topic, too often, already known, a bad source, or something else (see `note`). */
export const feedbackReasonSchema = z.enum(['topic', 'frequency', 'known', 'source', 'other']);
export type FeedbackReason = z.infer<typeof feedbackReasonSchema>;

/**
 * A post an agent publishes to the owner's feed: news or progress the user may care about, that
 * needs no action from them. Discussing a post happens in the client (a draft in that agent's chat).
 */
export const feedPostSchema = z.object({
  id: idSchema,
  agentId: idSchema,
  /** One line, what the card headline shows. */
  title: z.string().min(1).max(80).refine((value) => !/[\r\n]/.test(value), 'must be a single line'),
  /** One or two plain sentences: what the card shows. */
  summary: z.string().min(1).max(240),
  /** Markdown write-up, only when there is more than the summary can carry. */
  body: z.string().min(1).max(6000).optional(),
  /** Structured detail (dates, prices, specs) as display blocks. */
  ui: feedUiDocSchema.optional(),
  /** https thumbnail depicting the subject, never a site logo. */
  imageUrl: z.string().min(1).optional(),
  /** One line on what the picture shows (the agent looked at it); alt text for clients. Present whenever `imageUrl` is. */
  imageCaption: z.string().min(1).max(120).optional(),
  sourceUrl: z.string().min(1).optional(),
  /** The routine whose run published this post; absent for a post the agent made outside a routine. */
  routineId: idSchema.optional(),
  /** The owner's "more like this" / "less like this" on the post. */
  feedback: feedbackSignalSchema.optional(),
  /** Why, when the owner gave a reason with the feedback. */
  feedbackReason: feedbackReasonSchema.optional(),
  /** The owner's own words (at most 200 characters). */
  feedbackNote: z.string().max(200).optional(),
  liked: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type FeedPost = z.infer<typeof feedPostSchema>;

export const likeFeedPostInputSchema = z.object({ liked: z.boolean() });
export type LikeFeedPostInput = z.infer<typeof likeFeedPostInputSchema>;

export const feedbackInputSchema = z.object({ signal: feedbackSignalSchema, reason: feedbackReasonSchema.optional(), note: z.string().trim().max(200).optional() });
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;

// --- Today (the Chat tab header) -------------------------------------------

export const userStateSchema = z.enum(['new', 'starting', 'regular']);
export type UserState = z.infer<typeof userStateSchema>;

/** What tapping an inspiration does: open a chat with `text` prefilled (no `agentId` = the client opens the new-agent form), or start unlocking a missing capability. */
export const inspirationActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat'), agentId: idSchema.optional(), text: z.string().min(1).max(300) }),
  /** "Turn on a capability": `connector` opens that catalog connector's connect flow, `computer` the agent's computer setup, `profile` the profile form. */
  z.object({ type: z.literal('unlock'), target: z.enum(['connector', 'computer', 'profile']), connectorId: z.string().min(1).optional(), agentId: idSchema.optional() }),
]);
export type InspirationAction = z.infer<typeof inspirationActionSchema>;

/** One thing the app suggests. `id` is stable (`cap-mail-digest` for starters, the idea id for ideas) and is what dismiss takes. */
export const inspirationSchema = z.object({
  id: idSchema,
  source: z.enum(['idea', 'capability', 'profile', 'unlock']),
  title: z.string().min(1).max(80),
  /** The text sent when tapped; for an `unlock` card the button label (the `title` is the benefit). */
  prompt: z.string().min(1).max(300),
  agentId: idSchema.optional(),
  /** Why it is offered ("Gmail is connected"). */
  reason: z.string().min(1).max(120).optional(),
  action: inspirationActionSchema,
});
export type Inspiration = z.infer<typeof inspirationSchema>;

const workingRunSchema = z.object({ agentId: idSchema, runId: idSchema, title: z.string() });

/** One thing in the Today "needs you" list (BACKEND §10.17). */
export const todayNeedsYouItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), requestId: idSchema, agentId: idSchema, title: z.string() }),
  z.object({ kind: z.literal('memory_review'), itemId: idSchema, text: z.string() }),
  z.object({ kind: z.literal('possible_match'), accountId: idSchema, accountName: z.string(), personId: idSchema, personName: z.string() }),
]);
export type TodayNeedsYouItem = z.infer<typeof todayNeedsYouItemSchema>;

export const todaySchema = z.object({
  /** What the greeting is based on: the owner's local clock. */
  now: z.object({ hour: z.number().int().min(0).max(23), localDate: isoDateSchema, timezone: z.string().min(1) }),
  needsYou: z.object({
    /** Pending approvals and questions (the requests the owner has to answer). */
    count: z.number().int().min(0),
    top: z.array(z.object({ requestId: idSchema, agentId: idSchema, title: z.string() })).max(2),
    /** Everything the owner should look at, all kinds together: the pending requests, then the memory items to review, then the possible
     * account matches. `total` counts all of them; `items` is capped at 10 (requests first). */
    total: z.number().int().min(0),
    items: z.array(todayNeedsYouItemSchema).max(10),
  }),
  /** Runs that are working now (the same list as `progress.working`, kept at the top for the clients that read it there). */
  working: z.array(workingRunSchema),
  /** What is moving: today's runs, the working agents, and the goals with progress (active goals, at most 5). */
  progress: z.object({
    runsToday: z.number().int().min(0),
    working: z.array(workingRunSchema),
    goals: z.array(z.object({ goalId: idSchema, agentId: idSchema, title: z.string(), done: z.number().int().min(0), total: z.number().int().min(0) })).max(5),
  }),
  /** The latest posts in the feed, newest first (at most 5). */
  feed: z.array(feedPostSchema.pick({ id: true, agentId: true, title: true, summary: true, imageUrl: true, createdAt: true, liked: true })).max(5),
  /** Open ideas, newest first (at most 3). */
  ideas: z.array(ideaSchema).max(3),
  /** Today's posts made by routine runs (local day); absent when no routine posted yet today. */
  brief: z.object({
    /** The routine that made the newest post today. */
    routineId: idSchema,
    postIds: z.array(idSchema),
    /** One line: the newest post's title, plus "· N more" when there are others. */
    summary: z.string(),
    at: isoDateTimeSchema,
  }).optional(),
  /** `new` = no agents yet; `starting` = has agents but fewer than 10 messages sent in total (cold start); else `regular`. */
  userState: userStateSchema,
  /** Top-level runs that finished in the last 24h and the owner has not seen (newest first, at most 3). */
  completed: z.array(z.object({ runId: idSchema, agentId: idSchema, title: z.string(), finishedAt: isoDateTimeSchema })).max(3),
  /** What the app can do for the owner, at most 3: daily ideas first, then profile starters, then capability starters, and one `unlock` card last. Never shown again after dismissal, nor for more than 3 days. */
  inspiration: z.array(inspirationSchema).max(5),
});
export type Today = z.infer<typeof todaySchema>;
