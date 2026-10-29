import type {
  ListResult,
  MemoryItemTopic,
  MemoryItemView,
  PersonView,
  PossibleMatch,
  ReviewMemoryItemInput,
  UpdateMemoryItemInput,
} from "@agent-desktop/client";
import { useMutation, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";

/*
 * People and memory items (Team's People and Memory segments, contract 0.60.0). Every action is optimistic: the cached
 * lists change at once, and an error puts back the snapshot the action started from.
 */

/** Status of an error the People and Memory routes can answer with. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/** 404: the route is not there (the feature check the Team screen shows as "Coming soon"). */
export function isUnavailable(error: unknown): boolean {
  return statusOf(error) === 404;
}

/** 503: memory is unavailable right now; the segment says so quietly instead of as an error. */
export function isMemoryUnavailable(error: unknown): boolean {
  return statusOf(error) === 503;
}

/** Not retried: a 404 or 503 means "not now", and any other error should surface at once. */
const FEATURE_CHECK = { retry: false } as const;

const PEOPLE = ["people"] as const;
const MATCHES = ["people", "possible-matches"] as const;
const MEMORY = ["memory-items"] as const;
const REVIEW = ["memory-review"] as const;
const TOPICS = ["memory-topics"] as const;

type PeopleList = ListResult<PersonView>;
type MatchList = ListResult<PossibleMatch>;
type MemoryPages = InfiniteData<ListResult<MemoryItemView>, string | undefined>;
type ReviewList = { items: MemoryItemView[] };

/** What an optimistic change replaced, so an error can put it back. */
interface PeopleSnapshot {
  people?: PeopleList | undefined;
  matches?: MatchList | undefined;
}
interface MemorySnapshot {
  /** Every cached list of items (all of them and one per topic), by query key. */
  memory: Array<[QueryKey, MemoryPages | undefined]>;
  review?: ReviewList | undefined;
}

async function cancelAll(qc: QueryClient, keys: ReadonlyArray<readonly unknown[]>): Promise<void> {
  await Promise.all(keys.map((queryKey) => qc.cancelQueries({ queryKey })));
}

function invalidatePeople(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: PEOPLE });
}

function invalidateMemory(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: MEMORY });
  void qc.invalidateQueries({ queryKey: REVIEW });
  void qc.invalidateQueries({ queryKey: TOPICS });
}

/** Change people and matches in the cache; `null` removes one. Returns what was there before. */
function patchPeople(
  qc: QueryClient,
  change: { person?: (person: PersonView) => PersonView | null; match?: (match: PossibleMatch) => PossibleMatch | null },
): PeopleSnapshot {
  const snapshot: PeopleSnapshot = { people: qc.getQueryData<PeopleList>(PEOPLE), matches: qc.getQueryData<MatchList>(MATCHES) };
  if (snapshot.people && change.person) {
    const update = change.person;
    qc.setQueryData<PeopleList>(PEOPLE, {
      ...snapshot.people,
      items: snapshot.people.items.flatMap((person) => {
        const next = update(person);
        return next ? [next] : [];
      }),
    });
  }
  if (snapshot.matches && change.match) {
    const update = change.match;
    qc.setQueryData<MatchList>(MATCHES, {
      ...snapshot.matches,
      items: snapshot.matches.items.flatMap((match) => {
        const next = update(match);
        return next ? [next] : [];
      }),
    });
  }
  return snapshot;
}

function restorePeople(qc: QueryClient, snapshot: PeopleSnapshot): void {
  if (snapshot.people) qc.setQueryData<PeopleList>(PEOPLE, snapshot.people);
  if (snapshot.matches) qc.setQueryData<MatchList>(MATCHES, snapshot.matches);
}

/** Change memory items everywhere they are cached (the list pages and the review queue); `null` removes one. */
function patchMemory(qc: QueryClient, change: (item: MemoryItemView) => MemoryItemView | null): MemorySnapshot {
  const snapshot = memorySnapshot(qc);
  const { review } = snapshot;
  for (const [key, memory] of snapshot.memory) {
    if (!memory) continue;
    qc.setQueryData<MemoryPages>(key, {
      ...memory,
      pages: memory.pages.map((page) => ({
        ...page,
        items: page.items.flatMap((item) => {
          const next = change(item);
          return next ? [next] : [];
        }),
      })),
    });
  }
  if (review) {
    qc.setQueryData<ReviewList>(REVIEW, {
      ...review,
      items: review.items.flatMap((item) => {
        const next = change(item);
        return next ? [next] : [];
      }),
    });
  }
  return snapshot;
}

function memorySnapshot(qc: QueryClient): MemorySnapshot {
  return { memory: qc.getQueriesData<MemoryPages>({ queryKey: MEMORY }), review: qc.getQueryData<ReviewList>(REVIEW) };
}

function restoreMemory(qc: QueryClient, snapshot: MemorySnapshot): void {
  for (const [key, memory] of snapshot.memory) qc.setQueryData<MemoryPages>(key, memory);
  if (snapshot.review) qc.setQueryData<ReviewList>(REVIEW, snapshot.review);
}

export function usePeople() {
  const client = useClient();
  return useQuery({ queryKey: PEOPLE, queryFn: () => client.people.list({ limit: 50 }), ...FEATURE_CHECK });
}

export function usePossibleMatches(enabled: boolean) {
  const client = useClient();
  return useQuery({
    queryKey: MATCHES,
    queryFn: () => client.people.possibleMatches(),
    enabled,
    ...FEATURE_CHECK,
  });
}

/** Link a suggested account to the person it matches (the owner confirms first, in the screen). */
export function useLinkMatch() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (match: PossibleMatch) => client.people.link(match.person.id, match.account.id),
    onMutate: async (match) => {
      await cancelAll(qc, [MATCHES, PEOPLE]);
      return patchPeople(qc, { match: (candidate) => (candidate.account.id === match.account.id ? null : candidate) });
    },
    onError: (_error, _match, snapshot) => snapshot && restorePeople(qc, snapshot),
    onSettled: () => invalidatePeople(qc),
  });
}

/** Take an account off its person. */
export function useUnlinkAccount() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId }: { personId: string; accountId: string }) => client.people.unlinkAccount(accountId),
    onMutate: async ({ personId, accountId }) => {
      await cancelAll(qc, [PEOPLE]);
      return patchPeople(qc, {
        person: (person) =>
          person.id === personId ? { ...person, accounts: person.accounts.filter((account) => account.id !== accountId) } : person,
      });
    },
    onError: (_error, _vars, snapshot) => snapshot && restorePeople(qc, snapshot),
    onSettled: () => invalidatePeople(qc),
  });
}

/** Rename a person. */
export function useRenamePerson() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ personId, name }: { personId: string; name: string }) => client.people.rename(personId, name),
    onMutate: async ({ personId, name }) => {
      await cancelAll(qc, [PEOPLE]);
      return patchPeople(qc, { person: (person) => (person.id === personId ? { ...person, name } : person) });
    },
    onError: (_error, _vars, snapshot) => snapshot && restorePeople(qc, snapshot),
    onSettled: () => invalidatePeople(qc),
  });
}

/** Confirm a relation the owner did not say themselves. */
export function useConfirmRelation() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ relationId }: { personId: string; relationId: string }) => client.people.confirmRelation(relationId),
    onMutate: async ({ personId, relationId }) => {
      await cancelAll(qc, [PEOPLE]);
      return patchPeople(qc, {
        person: (person) =>
          person.id === personId
            ? { ...person, relations: person.relations.map((relation) => (relation.id === relationId ? { ...relation, confirmed: true } : relation)) }
            : person,
      });
    },
    onError: (_error, _vars, snapshot) => snapshot && restorePeople(qc, snapshot),
    onSettled: () => invalidatePeople(qc),
  });
}

/** Remove a relation between two people. */
export function useDeleteRelation() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ relationId }: { personId: string; relationId: string }) => client.people.deleteRelation(relationId),
    onMutate: async ({ personId, relationId }) => {
      await cancelAll(qc, [PEOPLE]);
      return patchPeople(qc, {
        person: (person) =>
          person.id === personId ? { ...person, relations: person.relations.filter((relation) => relation.id !== relationId) } : person,
      });
    },
    onError: (_error, _vars, snapshot) => snapshot && restorePeople(qc, snapshot),
    onSettled: () => invalidatePeople(qc),
  });
}

/** The owner's memory items, one cursor page at a time: all of them, or (with `topic`) one topic's. */
export function useMemoryItems(enabled: boolean, topic?: MemoryItemTopic) {
  const client = useClient();
  return useInfiniteQuery({
    queryKey: topic ? [...MEMORY, topic] : MEMORY,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => client.memoryItems.list({ ...(topic ? { topic } : {}), ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    ...FEATURE_CHECK,
  });
}

/** The topics that have items (the Memory segment's cards), each with its summary and count. */
export function useMemoryTopics(enabled: boolean) {
  const client = useClient();
  return useQuery({ queryKey: TOPICS, queryFn: () => client.memoryItems.topics(), enabled, ...FEATURE_CHECK });
}

export function useMemoryReview(enabled: boolean) {
  const client = useClient();
  return useQuery({ queryKey: REVIEW, queryFn: () => client.memoryItems.review(), enabled, ...FEATURE_CHECK });
}

/** Edit an item: its text, who may hear it (`owner` or `public`; omit it to keep a group audience) or whether it is sensitive. */
export function useUpdateMemoryItem() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateMemoryItemInput }) => client.memoryItems.update(id, patch),
    onMutate: async ({ id, patch }) => {
      await cancelAll(qc, [MEMORY, REVIEW]);
      return patchMemory(qc, (item) =>
        item.id === id
          ? {
              ...item,
              ...(patch.text !== undefined ? { text: patch.text } : {}),
              ...(patch.sensitive !== undefined ? { sensitive: patch.sensitive } : {}),
              ...(patch.audience !== undefined ? { audience: { ...item.audience, kind: patch.audience } } : {}),
            }
          : item,
      );
    },
    onError: (_error, _vars, snapshot) => snapshot && restoreMemory(qc, snapshot),
    onSettled: () => invalidateMemory(qc),
  });
}

/** Forget a memory item (DELETE); it leaves both the list and the review queue. */
export function useDeleteMemoryItem() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.memoryItems.delete(id),
    onMutate: async (id) => {
      await cancelAll(qc, [MEMORY, REVIEW]);
      return patchMemory(qc, (item) => (item.id === id ? null : item));
    },
    onError: (_error, _id, snapshot) => snapshot && restoreMemory(qc, snapshot),
    onSettled: () => invalidateMemory(qc),
  });
}

/** Keep an item the review queue holds (optionally about a person), or delete it. Either way it leaves the queue. */
export function useResolveMemoryReview() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReviewMemoryItemInput }) => client.memoryItems.resolveReview(id, input),
    onMutate: async ({ id, input }) => {
      await cancelAll(qc, [MEMORY, REVIEW]);
      const snapshot = memorySnapshot(qc);
      // Either way the item leaves the review queue; keep stays in the list (still remembered), delete leaves everywhere.
      if (snapshot.review) qc.setQueryData<ReviewList>(REVIEW, { ...snapshot.review, items: snapshot.review.items.filter((item) => item.id !== id) });
      if (input.action === "delete") patchMemory(qc, (item) => (item.id === id ? null : item));
      return snapshot;
    },
    onError: (_error, _vars, snapshot) => snapshot && restoreMemory(qc, snapshot),
    onSettled: () => invalidateMemory(qc),
  });
}
