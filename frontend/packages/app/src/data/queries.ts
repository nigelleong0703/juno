import { resolveAgentComputer } from "../components/computer/useScreenState";
import type {
  AgentsListParams,
  AuditListParams,
  Conversation,
  ConversationsListParams,
  FeedListParams,
  GoalsListParams,
  LibraryListParams,
  PluginsListParams,
  Request,
  RequestsListParams,
  RoutinesListParams,
  RulesListParams,
  RunsListParams,
} from "@agent-desktop/client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useClient } from "./ClientProvider";
import { sortItemsChronologically } from "./events";
import { qk } from "./keys";
import { listAllRuns } from "./run-pages";

/** The skills page reads one bounded, owner-scoped page instead of an unbounded scan. */
const SKILLS_PAGE_LIMIT = 200;

// --- Agents ----------------------------------------------------------------
export function useAgents(params?: AgentsListParams) {
  const client = useClient();
  return useQuery({
    queryKey: qk.agents(params),
    queryFn: async () => (await client.agents.list(params)).items,
  });
}

export function useAgent(id: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.agent(id ?? ""),
    queryFn: () => client.agents.get(id as string),
    enabled: Boolean(id),
  });
}

// --- Conversations & items -------------------------------------------------
export function useConversations(params?: ConversationsListParams) {
  const client = useClient();
  return useQuery({
    queryKey: qk.conversations(params),
    queryFn: async () => (await client.conversations.list(params)).items,
  });
}

export function useConversation(id: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.conversation(id ?? ""),
    queryFn: () => client.conversations.get(id as string),
    enabled: Boolean(id),
  });
}

export function useItems(conversationId: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.items(conversationId ?? ""),
    queryFn: async () => (await client.conversations.items(conversationId as string)).items,
    // The endpoint does not guarantee `at` order (owner feedback 2026-10-05), so the reader sorts
    // every read — fetched and streamed alike — without changing what the server stores.
    select: sortItemsChronologically,
    enabled: Boolean(conversationId),
  });
}

// --- Runs ------------------------------------------------------------------
export function useRuns(params?: RunsListParams) {
  const client = useClient();
  return useQuery({
    queryKey: qk.runs(params),
    // The backend pages runs and does not sort by recency, so the run the caller wants can sit
    // past the first cursor page (owner baseline 2026-10-08). Read every page into the same list.
    queryFn: () => listAllRuns(client, params),
  });
}

export function useRun(id: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.run(id ?? ""),
    queryFn: () => client.runs.get(id as string),
    enabled: Boolean(id),
  });
}

// --- Requests --------------------------------------------------------------
export function useRequests(params?: RequestsListParams) {
  const client = useClient();
  return useQuery({
    queryKey: qk.requests(params),
    queryFn: async () => (await client.requests.list(params)).items,
  });
}

export function useRequest(id: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.request(id ?? ""),
    queryFn: () => client.requests.get(id as string),
    enabled: Boolean(id),
  });
}

/** Pending approvals / questions / sign-ins — the Inbox badge and "Needs you" card. */
export function usePendingRequests() {
  return useRequests({ status: "pending" });
}

/**
 * A question or connect card in a direct chat is the agent talking, not the owner being needed: it stays inline in its
 * chat and counts nowhere as "needs you". Approvals, sign-ins, secure input and take-over still do.
 */
export function isQuietRequest(request: Request, conversations: readonly Conversation[] | undefined): boolean {
  if (request.kind !== "question" && request.kind !== "connect") return false;
  return conversations?.find((entry) => entry.id === request.conversationId)?.kind === "direct";
}

/** Pending requests that wait on the owner: the badges, the chip count and Today's Needs-you block. */
export function useNeedsYouRequests() {
  const { data: pending, ...rest } = usePendingRequests();
  const { data: conversations } = useConversations();
  const data = pending?.filter((request) => !isQuietRequest(request, conversations));
  return { data, ...rest };
}

// --- Ideas -----------------------------------------------------------------
/** Open suggestions the agents offer the user (Muse's Ideas); kept current by `idea.updated`. */
export function useOpenIdeas() {
  const client = useClient();
  const params = { status: "open" } as const;
  return useQuery({
    queryKey: qk.ideas(params),
    queryFn: async () => (await client.ideas.list(params)).items,
  });
}

// --- Routines --------------------------------------------------------------
export function useRoutines(params?: RoutinesListParams) {
  const client = useClient();
  return useQuery({
    queryKey: qk.routines(params),
    queryFn: async () => (await client.routines.list(params)).items,
  });
}

export function useRoutine(id: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.routine(id ?? ""),
    queryFn: () => client.routines.get(id as string),
    enabled: Boolean(id),
  });
}

// --- Computers -------------------------------------------------------------
export function useComputers() {
  const client = useClient();
  return useQuery({
    queryKey: qk.computers(),
    queryFn: async () => (await client.computers.list()).items,
  });
}

export function useComputer(id: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.computer(id ?? ""),
    queryFn: () => client.computers.get(id as string),
    enabled: Boolean(id),
  });
}

/** Resolve the (shared) computer an agent uses from the cached computer list (no extra fetch). */
export function useAgentComputer(agentId: string | undefined) {
  const query = useComputers();
  const computer = useMemo(() => resolveAgentComputer(query.data, agentId), [query.data, agentId]);
  return { ...query, computer };
}

// --- Catalog (usage, settings, library, …) ---------------------------------
export function useUsage() {
  const client = useClient();
  return useQuery({ queryKey: qk.usage(), queryFn: () => client.usage.get() });
}

export function useSettings() {
  const client = useClient();
  return useQuery({ queryKey: qk.settings(), queryFn: () => client.settings.get() });
}

// --- Model providers (BACKEND §10.14) ---------------------------------------
/** The owner's providers plus `usable`: false means no run can start until one is added. */
export function useModelProviders() {
  const client = useClient();
  return useQuery({ queryKey: qk.modelProviders(), queryFn: () => client.modelProviders.list() });
}

export function useBuiltinProviders() {
  const client = useClient();
  return useQuery({
    queryKey: qk.builtinProviders(),
    queryFn: async () => (await client.modelProviders.builtin()).items,
    staleTime: 5 * 60_000,
  });
}

/** One provider's model catalog. No retries: the picker shows its own Retry (503 is common). */
export function useProviderModels(providerId: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.providerModels(providerId ?? ""),
    queryFn: () => client.modelProviders.models(providerId as string),
    enabled: Boolean(providerId),
    retry: false,
  });
}

export function useLibrary(
  params?: LibraryListParams & { conversationId?: string },
  enabled = true,
) {
  const client = useClient();
  return useQuery({
    queryKey: qk.library(params),
    queryFn: async () => (await client.library.list(params)).items,
    enabled,
  });
}

const FIRST_SKILLS_CURSOR: string | undefined = undefined;

/** Bounded, cursor-paged skills list: the first page never silently hides older skills. */
export function useSkillsPage(limit: number = SKILLS_PAGE_LIMIT) {
  const client = useClient();
  return useInfiniteQuery({
    queryKey: ["skills", "page", limit],
    initialPageParam: FIRST_SKILLS_CURSOR,
    queryFn: async ({ pageParam }) =>
      client.skills.list(pageParam === undefined ? { limit } : { limit, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}


export function useRules(params?: RulesListParams) {
  const client = useClient();
  return useQuery({
    queryKey: qk.rules(params),
    queryFn: async () => (await client.rules.list(params)).items,
  });
}

/** The owner's proactive preferences (what the agents may message about unprompted). */
export function useProactiveRules() {
  const client = useClient();
  return useQuery({
    queryKey: qk.proactiveRules(),
    queryFn: async () => (await client.proactive.listRules()).items,
  });
}

export function usePlugins(params?: PluginsListParams) {
  const client = useClient();
  return useQuery({
    queryKey: qk.plugins(params),
    queryFn: async () => (await client.plugins.list(params)).items,
  });
}

const AUDIT_PAGE_LIMIT = 20;

/** The activity log, a page at a time (newest first); the filters are the server's. */
export function useAudit(params?: Pick<AuditListParams, "agentId" | "initiator" | "unattended">) {
  const client = useClient();
  return useInfiniteQuery({
    queryKey: qk.audit(params),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => client.audit.list({ ...params, limit: AUDIT_PAGE_LIMIT, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

// --- Goals & feed (MUSE-PARITY step 7, BACKEND §10.10) ----------------------
export function useGoals(params?: GoalsListParams) {
  const client = useClient();
  return useQuery({
    queryKey: qk.goals(params),
    queryFn: async () => (await client.goals.list(params)).items,
  });
}

/** One goal with its activity timeline (the list omits activity). */
export function useGoal(id: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: qk.goal(id ?? ""),
    queryFn: () => client.goals.get(id as string),
    enabled: Boolean(id),
  });
}

/** Feed posts newest first, one page at a time: the user asks for more instead of a silent cap. */
export const FEED_PAGE_LIMIT = 20;

export function useFeed(params?: Omit<FeedListParams, "limit" | "cursor">) {
  const client = useClient();
  return useInfiniteQuery({
    queryKey: qk.feed(params),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.feed.list({ ...params, limit: FEED_PAGE_LIMIT, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
