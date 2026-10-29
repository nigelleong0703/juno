import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from './common.js';

// --- The owner's people (the People segment; BACKEND §9.5, §9.6, §10.17) ----

/** An account the owner's people speak from. `platform` is the account's platform (telegram, slack, ..., app, meet). */
export const accountViewSchema = z.object({
  id: idSchema,
  platform: z.string().min(1),
  /** The display name the platform shows now; null when none was seen. */
  name: z.string().nullable(),
  /** The chat the account was last seen in; absent when none was recorded. */
  lastChat: z.string().optional(),
  lastSeen: isoDateTimeSchema,
});
export type AccountView = z.infer<typeof accountViewSchema>;

/**
 * A relation as one of its people sees it: "this person is <kind> of <other>" when `direction` is `out` (this person is the first end),
 * "<other> is <kind> of this person" when `in`. For the symmetric kinds (colleague, spouse, sibling, friend) the direction carries no meaning.
 */
export const personRelationViewSchema = z.object({
  id: idSchema,
  /** One of the fixed kinds (manager_of, colleague, client_of, works_at, spouse, parent_of, sibling, friend) or `other`. */
  kind: z.string().min(1),
  /** The wording, when `kind` is `other`. */
  kindLabel: z.string().nullable(),
  otherPersonId: idSchema,
  otherName: z.string(),
  direction: z.enum(['out', 'in']),
  /** True when the owner said it or confirmed it. */
  confirmed: z.boolean(),
});
export type PersonRelationView = z.infer<typeof personRelationViewSchema>;

export const personViewSchema = z.object({
  id: idSchema,
  name: z.string().min(1),
  isOwner: z.boolean(),
  accounts: z.array(accountViewSchema),
  relations: z.array(personRelationViewSchema),
  /** The latest time one of the accounts was seen; the list is ordered by it, newest first. */
  lastActivityAt: isoDateTimeSchema,
});
export type PersonView = z.infer<typeof personViewSchema>;

/** A person as a reference (the possible matches, the rename's answer). */
export const personRefSchema = z.object({ id: idSchema, name: z.string().min(1), isOwner: z.boolean() });
export type PersonRef = z.infer<typeof personRefSchema>;

/** `GET /v1/people/possible-matches`: an account not linked to this person, whose name is the person's name. Only a suggestion. */
export const possibleMatchSchema = z.object({ account: accountViewSchema, person: personRefSchema });
export type PossibleMatch = z.infer<typeof possibleMatchSchema>;

/** `PATCH /v1/people/:id`. */
export const renamePersonInputSchema = z.object({ name: z.string().trim().min(1).max(80) });
export type RenamePersonInput = z.infer<typeof renamePersonInputSchema>;

/** `POST /v1/people/:id/link`. */
export const linkAccountInputSchema = z.object({ accountId: idSchema });
export type LinkAccountInput = z.infer<typeof linkAccountInputSchema>;

/** `POST /v1/relations/:id/confirm`: the relation as confirmed. */
export const confirmRelationResultSchema = z.object({ id: idSchema, confirmed: z.literal(true) });
export type ConfirmRelationResult = z.infer<typeof confirmRelationResultSchema>;

// --- The owner's memory items (the Memory segment; BACKEND §5.4, §10.17) ----

export const memoryItemStatusSchema = z.enum(['active', 'retracted', 'needs_review']);
export type MemoryItemStatus = z.infer<typeof memoryItemStatusSchema>;

/** What a memory item is about at a glance (the Memory page's sections). An item the tidy has not sorted yet reads as `other`. */
export const MEMORY_ITEM_TOPICS = ['identity', 'health', 'work', 'plans', 'preferences', 'people', 'agents', 'home', 'other'] as const;
export const memoryItemTopicSchema = z.enum(MEMORY_ITEM_TOPICS);
export type MemoryItemTopic = z.infer<typeof memoryItemTopicSchema>;

/**
 * A memory item as the Memory segment shows it. The labels are for reading ("Your chat", "Gym crew", "Only you"): the app shows them as they
 * are. `audience.kind` says who may hear the item: the owner alone, one group, or everyone.
 */
export const memoryItemViewSchema = z.object({
  id: idSchema,
  /** One short statement. About the owner it has no subject ("Wants to build muscle"); about anyone else it starts with their name. */
  text: z.string(),
  /** The item's kind: fact, preference, plan, relationship, role, circumstance or experience. */
  kind: z.string().min(1),
  /** The section of the Memory page it belongs to; `other` until the nightly tidy has sorted it. */
  topic: memoryItemTopicSchema,
  about: z.object({ personId: idSchema, name: z.string() }).nullable(),
  saidBy: z.object({ kind: z.enum(['owner', 'person', 'agent', 'account']), name: z.string() }).nullable(),
  saidIn: z.object({ label: z.string() }),
  audience: z.object({ kind: z.enum(['owner', 'group', 'public']), label: z.string() }),
  sensitive: z.boolean(),
  /** Set = private to that agent. */
  agentId: idSchema.optional(),
  status: memoryItemStatusSchema,
  createdAt: isoDateTimeSchema,
  /**
   * The person's own words this item came from (at most 280 characters, cut at a word with "…"), and when they wrote them. Null when the
   * item rests on an agent's inference (`memory_note`) or a tool, on no recorded message, or when the message is gone. Where it was said
   * is `saidIn`; the quote does not repeat it.
   */
  quote: z.object({ text: z.string().min(1).max(280), at: isoDateTimeSchema }).nullable().optional(),
});
export type MemoryItemView = z.infer<typeof memoryItemViewSchema>;

/**
 * One section of the Memory page (`GET /v1/memory/topics` answers `{items: MemoryTopicView[]}`, the topics that have items, in the fixed
 * order of `MEMORY_ITEM_TOPICS`). `summary` is one to three sentences in the second person for the owner, written by the nightly job from
 * the owner's own and public items ("You're building muscle and cutting sugar."); empty until the first night after the topic got items.
 * `count` is all the active items of the topic (group items included, they are listed by `GET /v1/memory/items?topic=`).
 */
export const memoryTopicViewSchema = z.object({
  topic: memoryItemTopicSchema,
  label: z.string().min(1),
  /** The summary as plain text, markers removed. */
  summary: z.string(),
  /**
   * The same summary in pieces for the app to render as prose: a piece with `itemId` is a phrase that states that memory item and opens it
   * when tapped (`itemId` is only set while the item is active; otherwise the phrase is plain text). Concatenating `text` gives `summary`.
   */
  segments: z.array(z.object({ text: z.string().min(1), itemId: idSchema.optional() })),
  count: z.number().int().min(1),
  /** When the summary was written; the newest item's change while there is no summary yet. */
  updatedAt: isoDateTimeSchema,
});
export type MemoryTopicView = z.infer<typeof memoryTopicViewSchema>;

/**
 * `PATCH /v1/memory/items/:id`. Narrowing and widening are both the owner's to do; an omitted field keeps its value (a group audience
 * stays a group audience unless the owner picks `owner` or `public`).
 */
export const updateMemoryItemInputSchema = z.object({
  text: z.string().trim().min(1).max(1000).optional(),
  audience: z.enum(['owner', 'public']).optional(),
  sensitive: z.boolean().optional(),
}).refine((input) => Object.keys(input).length > 0, { message: 'nothing to change' });
export type UpdateMemoryItemInput = z.infer<typeof updateMemoryItemInputSchema>;

/** `POST /v1/memory/review/:id`: keep the item (optionally naming the person it is about) or delete it. */
export const reviewMemoryItemInputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('keep'), about: idSchema.optional() }),
  z.object({ action: z.literal('delete') }),
]);
export type ReviewMemoryItemInput = z.infer<typeof reviewMemoryItemInputSchema>;
