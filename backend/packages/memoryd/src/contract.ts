/**
 * The internal contract between agentd (the client) and memoryd (the server), BACKEND §2.4. One table of routes: each route's request
 * and response schemas are imported by both sides, so they cannot drift apart. This is not public-contracts: nothing outside the
 * backend calls it.
 *
 * Every request carries `ownerId` in its body and in the `x-owner-id` header; memoryd refuses a mismatch and scopes the call to that
 * owner. Presence (who is in the run) is sent by the caller and enforced by memoryd, which returns only what that presence may see.
 *
 * Owner-only routes (`/v1/owner/*`) are the owner's admin edits: the owner app's forget and view edits. They take the owner's
 * presence implicitly, so only agentd's owner routes call them, never the agent runtime.
 *
 * Shapes the JSON cannot carry (Maps, Sets, Dates) travel in a plain form and are rebuilt on each side: the digest context (its
 * sender lookup), the section's delivered set and the digest's `now`.
 */
import { z } from 'zod';
import type { ForgetMemoryResult } from '@agent-desktop/public-contracts';
import { ACCOUNT_PLATFORMS, type Account, type AccountInput, type Person } from '@agent-desktop/memory-graph/identity';
import { ITEM_FILES, ITEM_KINDS, ITEM_STATUSES, ITEM_TOPICS, type ItemPatch, type MemoryItem } from '@agent-desktop/memory-graph/memory';
import { RELATION_KINDS, type RecordOutcome, type RecordRelation, type Relation, type RelationView } from '@agent-desktop/memory-graph/relations';
import type { WakeEvent } from 'juno-agent/contracts';
import type { Explanation, Reference } from 'juno-agent/modules/memory/explain';
import type { ClaimsContext, ClaimsResult } from 'juno-agent/modules/memory/jobs/claims';
import type { SourceItem } from 'juno-agent/modules/memory/jobs/gather';
import type { PersonRelation, PersonView, PossibleMatch } from 'juno-agent/modules/memory/owner-edits';
import type { NoteOutcome } from 'juno-agent/modules/memory/dedupe';
import type { TopicView } from 'juno-agent/modules/memory/owner-edits';
import type { MemorySearchHit } from 'juno-agent/modules/memory/port';
import type { MemorySection } from 'juno-agent/modules/memory/section';
import type { RelationsResult } from 'juno-agent/modules/memory/relations';
import type { AgentHomeRow } from 'juno-agent/contracts/storage';

const isObject = (value: unknown): boolean => typeof value === 'object' && value !== null;
/** A value checked only as an object: the shape is the TypeScript type's, and the contract tests hold both sides to it. */
const objectOf = <T>(): z.ZodType<T> => z.custom<T>(isObject);

export const ownerIdSchema = z.string().min(1);
const nullableString = z.string().nullable();

export const presenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('owner') }),
  z.object({ kind: z.literal('group'), groupKey: z.string().min(1) }),
  z.object({ kind: z.literal('other') }),
]);

export const newItemSchema = z.object({
  id: z.string().min(1).optional(),
  text: z.string(),
  kind: z.enum(ITEM_KINDS),
  file: z.enum(ITEM_FILES),
  topic: z.enum(ITEM_TOPICS).nullable().optional(),
  aboutPersonId: nullableString.optional(),
  agentId: nullableString.optional(),
  saidByPersonId: nullableString.optional(),
  saidByAccountId: nullableString.optional(),
  saidByAgentId: nullableString.optional(),
  saidIn: z.string(),
  audience: z.string(),
  sensitive: z.boolean().optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  claimId: nullableString.optional(),
  evidence: z.array(z.object({ itemId: z.string(), quote: z.string() })).nullable().optional(),
  legacyRef: nullableString.optional(),
  createdAt: z.string().optional(),
});

export const memoryItemSchema: z.ZodType<MemoryItem> = z.object({
  id: z.string(),
  ownerId: z.string(),
  text: z.string(),
  kind: z.enum(ITEM_KINDS),
  file: z.enum(ITEM_FILES),
  topic: z.enum(ITEM_TOPICS).nullable(),
  aboutPersonId: nullableString,
  agentId: nullableString,
  saidByPersonId: nullableString,
  saidByAccountId: nullableString,
  saidByAgentId: nullableString,
  saidIn: z.string(),
  audience: z.string(),
  sensitive: z.boolean(),
  status: z.enum(ITEM_STATUSES),
  claimId: nullableString,
  evidence: z.array(z.object({ itemId: z.string(), quote: z.string() })).nullable(),
  legacyRef: nullableString,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const personSchema: z.ZodType<Person> = z.object({
  id: z.string(),
  ownerId: z.string(),
  name: z.string(),
  isOwner: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const accountInputSchema: z.ZodType<AccountInput> = z.object({
  platform: z.enum(ACCOUNT_PLATFORMS),
  workspace: z.string().optional(),
  externalId: z.string(),
  name: z.string().nullable().optional(),
  lastChat: z.string().nullable().optional(),
});

export const accountSchema: z.ZodType<Account> = z.object({
  id: z.string(),
  ownerId: z.string(),
  platform: z.enum(ACCOUNT_PLATFORMS),
  workspace: z.string(),
  externalId: z.string(),
  name: nullableString,
  personId: nullableString,
  lastChat: z.string(),
  firstSeen: z.string(),
  lastSeen: z.string(),
});

/** The digest context as it travels: the sender lookup's maps as entry lists (see encodeClaimsContext). */
export type WireClaimsContext = Omit<ClaimsContext, 'senders'> & {
  senders: { labels: Array<[string, string]>; personOf: Array<[string, string]>; senderOf: Array<[string, { input: AccountInput; accountId?: string }]> };
};

export function encodeClaimsContext(context: ClaimsContext): WireClaimsContext {
  const { senders } = context;
  return {
    ...context,
    senders: { labels: [...senders.labels], personOf: [...senders.personOf], senderOf: [...senders.senderOf] },
  };
}

export function decodeClaimsContext(wire: WireClaimsContext): ClaimsContext {
  const { senders } = wire;
  return {
    ...wire,
    senders: { labels: new Map(senders.labels), personOf: new Map(senders.personOf), senderOf: new Map(senders.senderOf) },
  };
}

const sourceItemSchema = objectOf<SourceItem>();
const wireContextSchema = objectOf<WireClaimsContext>();
const wakeSchema = objectOf<WakeEvent>();

const relationViewSchema = objectOf<RelationView>();
const explanationSchema = objectOf<Explanation>();
const referenceSchema = z.union([z.object({ kind: z.literal('mem'), id: z.string() }), z.object({ kind: z.literal('claim'), id: z.string() })]) satisfies z.ZodType<Reference>;

const personRelationSchema: z.ZodType<PersonRelation> = z.object({
  id: z.string(),
  kind: z.enum(RELATION_KINDS),
  kindLabel: nullableString,
  otherPersonId: z.string(),
  otherName: z.string(),
  direction: z.enum(['out', 'in']),
  confirmed: z.boolean(),
});
const personViewSchema: z.ZodType<PersonView> = z.object({
  person: personSchema,
  accounts: z.array(accountSchema),
  relations: z.array(personRelationSchema),
  lastActivityAt: z.string(),
});
const possibleMatchSchema: z.ZodType<PossibleMatch> = z.object({ account: accountSchema, person: personSchema });
const itemStatusFilterSchema = z.enum(ITEM_STATUSES).optional();
const itemPatchSchema: z.ZodType<ItemPatch> = z.object({
  text: z.string().optional(),
  audience: z.string().optional(),
  sensitive: z.boolean().optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  topic: z.enum(ITEM_TOPICS).nullable().optional(),
  aboutPersonId: nullableString.optional(),
});
const topicViewSchema: z.ZodType<TopicView> = z.object({
  topic: z.enum(ITEM_TOPICS),
  summary: z.string(),
  segments: z.array(z.object({ text: z.string(), itemId: z.string().optional() })),
  count: z.number().int(),
  updatedAt: z.string(),
});
const okSchema = z.object({ ok: z.literal(true) });

/** The route table. `route` is the path under /v1; `owner` routes are the owner-only admin edits. */
export const routes = {
  addItem: { route: 'memory/addItem', input: z.object({ ownerId: ownerIdSchema, input: newItemSchema }), output: memoryItemSchema.nullable() },
  note: {
    route: 'memory/note',
    input: z.object({ ownerId: ownerIdSchema, input: newItemSchema }),
    output: z.object({ item: memoryItemSchema, updated: z.boolean() }).nullable() satisfies z.ZodType<NoteOutcome | null>,
  },
  memoryFor: {
    route: 'memory/memoryFor',
    input: z.object({ ownerId: ownerIdSchema, presence: presenceSchema, agentId: z.string().optional() }),
    output: z.array(memoryItemSchema),
  },
  search: {
    route: 'memory/search',
    input: z.object({ ownerId: ownerIdSchema, presence: presenceSchema, agentId: z.string().optional(), query: z.string(), limit: z.number().int().positive().optional() }),
    output: z.array(z.object({ item: memoryItemSchema, score: z.number() })) satisfies z.ZodType<MemorySearchHit[]>,
  },
  section: {
    route: 'memory/section',
    input: z.object({
      ownerId: ownerIdSchema,
      agentId: z.string(),
      presence: presenceSchema,
      wake: z.array(wakeSchema),
      canNote: z.boolean(),
      people: z.array(z.object({ id: z.string(), name: z.string() })),
      runStart: z.boolean(),
      delivered: z.array(z.string()),
    }),
    output: z.object({ section: z.string(), relevant: z.object({ ids: z.array(z.string()), text: z.string() }).optional() }) satisfies z.ZodType<MemorySection>,
  },
  explain: {
    route: 'memory/explain',
    input: z.object({ ownerId: ownerIdSchema, presence: presenceSchema, agentId: z.string().optional(), reference: referenceSchema }),
    output: explanationSchema,
  },
  renderViews: {
    route: 'memory/renderViews',
    input: z.object({ ownerId: ownerIdSchema, agentId: z.string() }),
    output: z.object({ ok: z.literal(true) }),
  },
  digestContext: {
    route: 'memory/digestContext',
    input: z.object({ ownerId: ownerIdSchema, items: z.array(sourceItemSchema), agents: z.array(z.object({ id: z.string(), name: z.string() })) }),
    output: z.object({ context: wireContextSchema, prompt: z.string() }),
  },
  applyDigest: {
    route: 'memory/applyDigest',
    input: z.object({
      ownerId: ownerIdSchema,
      agentId: z.string(),
      items: z.array(sourceItemSchema),
      claims: z.array(z.unknown()),
      context: wireContextSchema,
      now: z.string().datetime(),
    }),
    output: z.object({ claims: objectOf<ClaimsResult>(), relations: objectOf<RelationsResult>() }),
  },
  people: {
    list: { route: 'people/list', input: z.object({ ownerId: ownerIdSchema }), output: z.array(personSchema) },
    ensureOwner: { route: 'people/ensureOwner', input: z.object({ ownerId: ownerIdSchema, name: z.string() }), output: personSchema },
    createPerson: { route: 'people/createPerson', input: z.object({ ownerId: ownerIdSchema, name: z.string() }), output: personSchema },
    resolve: { route: 'people/resolve', input: z.object({ ownerId: ownerIdSchema, accountId: z.string() }), output: personSchema.nullable() },
    findAccount: { route: 'people/findAccount', input: z.object({ ownerId: ownerIdSchema, input: accountInputSchema }), output: accountSchema.nullable() },
    accountsOf: { route: 'people/accountsOf', input: z.object({ ownerId: ownerIdSchema, personId: z.string() }), output: z.array(accountSchema) },
    accountsWithPrefix: { route: 'people/accountsWithPrefix', input: z.object({ ownerId: ownerIdSchema, prefix: z.string() }), output: z.array(accountSchema) },
    listAccounts: { route: 'people/listAccounts', input: z.object({ ownerId: ownerIdSchema }), output: z.array(accountSchema) },
    linkAccount: { route: 'people/linkAccount', input: z.object({ ownerId: ownerIdSchema, accountId: z.string(), personId: z.string() }), output: accountSchema },
  },
  relations: {
    record: {
      route: 'relations/record',
      input: z.object({ ownerId: ownerIdSchema, input: objectOf<RecordRelation>() }),
      output: objectOf<RecordOutcome>(),
    },
    currentOf: { route: 'relations/currentOf', input: z.object({ ownerId: ownerIdSchema, personId: z.string() }), output: z.array(relationViewSchema) },
  },
  /** Owner-only: the owner's own edits of people, relations and items (BACKEND §10.17). Every one sees all of the owner's rows. */
  owner: {
    people: { route: 'owner/people', input: z.object({ ownerId: ownerIdSchema }), output: z.array(personViewSchema) },
    possibleMatches: { route: 'owner/possibleMatches', input: z.object({ ownerId: ownerIdSchema }), output: z.array(possibleMatchSchema) },
    unlinkAccount: { route: 'owner/unlinkAccount', input: z.object({ ownerId: ownerIdSchema, accountId: z.string() }), output: accountSchema },
    renamePerson: { route: 'owner/renamePerson', input: z.object({ ownerId: ownerIdSchema, personId: z.string(), name: z.string() }), output: personSchema },
    confirmRelation: { route: 'owner/confirmRelation', input: z.object({ ownerId: ownerIdSchema, relationId: z.string() }), output: objectOf<Relation>() },
    deleteRelation: { route: 'owner/deleteRelation', input: z.object({ ownerId: ownerIdSchema, relationId: z.string() }), output: okSchema },
    items: {
      route: 'owner/items',
      input: z.object({ ownerId: ownerIdSchema, aboutPersonId: z.string().optional(), status: itemStatusFilterSchema, topic: z.enum(ITEM_TOPICS).optional() }),
      output: z.array(memoryItemSchema),
    },
    topics: { route: 'owner/topics', input: z.object({ ownerId: ownerIdSchema }), output: z.array(topicViewSchema) },
    updateItem: { route: 'owner/updateItem', input: z.object({ ownerId: ownerIdSchema, id: z.string(), patch: itemPatchSchema }), output: memoryItemSchema },
    deleteItem: { route: 'owner/deleteItem', input: z.object({ ownerId: ownerIdSchema, id: z.string() }), output: okSchema },
  },
  /** Owner-only: the owner's forget (retract the claims and delete the items they made). */
  forget: {
    route: 'owner/forget',
    input: z.object({ ownerId: ownerIdSchema, agentId: z.string(), claimIds: z.array(z.string()) }),
    output: objectOf<ForgetMemoryResult>(),
  },
  /** Owner-only: the owner's edit of a memory view (MEMORY.md, a bank file, a people page). */
  saveView: {
    route: 'owner/views',
    input: z.object({ ownerId: ownerIdSchema, path: z.string(), content: z.string(), expectedHash: z.string().optional() }),
    output: objectOf<AgentHomeRow>().nullable(),
  },
} as const;

/**
 * Error kinds that travel as themselves: the memory-graph refusals and the home's conflict and unavailable errors (the owner's view
 * edit answers 409 and 503 on them), rebuilt on the client as the same classes. Anything else is a plain failure.
 */
export const DOMAIN_ERROR_KINDS = ['MemoryItemError', 'IdentityError', 'RelationError', 'HomeConflictError', 'HomeUnavailableError'] as const;
export type DomainErrorKind = (typeof DOMAIN_ERROR_KINDS)[number];

export const errorBodySchema = z.object({
  error: z.object({ kind: z.string(), code: z.string().optional(), message: z.string(), path: z.string().optional() }),
});

/** memoryd could not answer: unreachable, timed out, rejected the token, or failed inside. Reads degrade on it; writes fail with it. */
export class MemoryUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryUnavailableError';
  }
}

