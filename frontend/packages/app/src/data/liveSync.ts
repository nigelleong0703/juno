import type {
  Agent,
  AgentEvent,
  Computer,
  Conversation,
  FeedListParams,
  FeedPost,
  EventResetSource,
  EventSource,
  Goal,
  GoalsListParams,
  Idea,
  IdeasListParams,
  LibraryItem,
  Item,
  Request,
  RequestsListParams,
  Routine,
  Run,
  RunsListParams,
} from "@agent-desktop/client";
import { EventType, runSchema } from "@agent-desktop/client";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useEventSource } from "./ClientProvider";
import { applyAguiMessageEvent, resetAguiMessages } from "./aguiMessages";
import { junoOf } from "./aguiMetadata";
import { applyDocumentDraftEvent } from "./documents";
import { mergeItemChronologically } from "./events";
import { updateFeedPost, type FeedPages } from "./feed";
import { prefix, qk } from "./keys";
import { taskKeys } from "./queryKeys";
import { applyControlChange } from "./screens";
import { upsertTask } from "./tasks";
import { useAuthIdentity } from "../auth/AuthContext";

/**
 * Event stream → query cache reducer (ARCHITECTURE §7). Components never touch events;
 * this module is the single place that knows how an event maps onto cached entities.
 */

function patchLists<T>(
  qc: QueryClient,
  prefixKey: readonly unknown[],
  updater: (list: T[]) => T[],
): void {
  for (const [key, data] of qc.getQueriesData<T[]>({ queryKey: prefixKey as unknown[] })) {
    if (Array.isArray(data)) qc.setQueryData<T[]>(key, updater(data));
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [item, ...list];
  const next = list.slice();
  next[index] = item;
  return next;
}

function requestMatches(params: RequestsListParams | undefined, request: Request): boolean {
  if (!params) return true;
  if (params.status && params.status !== request.status) return false;
  if (params.kind && params.kind !== request.kind) return false;
  if (params.agentId && params.agentId !== request.agentId) return false;
  return true;
}

function runMatches(params: RunsListParams | undefined, run: Run): boolean {
  // Housekeeping runs (memory jobs etc.) never show as activity (mirrors the iPhone app).
  if (run.kind === "background") return false;
  if (!params) return true;
  if (params.status && params.status !== run.status) return false;
  if (params.agentId && params.agentId !== run.agentId) return false;
  if (params.conversationId && params.conversationId !== run.conversationId) return false;
  if (params.kind && params.kind !== run.kind) return false;
  return true;
}

function goalMatches(params: GoalsListParams | undefined, goal: Goal): boolean {
  if (!params) return true;
  if (params.agentId && params.agentId !== goal.agentId) return false;
  if (params.status && params.status !== goal.status) return false;
  return true;
}

/** A new post joins the first page of every feed list it belongs to (its agent filter, if any). */
function prependFeedPost(qc: QueryClient, post: FeedPost): void {
  for (const [key, data] of qc.getQueriesData<FeedPages>({ queryKey: prefix.feed })) {
    const params = key[1] as FeedListParams | undefined;
    if (!data || (params?.agentId && params.agentId !== post.agentId)) continue;
    if (data.pages.some((page) => page.items.some((entry) => entry.id === post.id))) continue;
    const [first, ...rest] = data.pages;
    if (!first) continue;
    qc.setQueryData<FeedPages>(key, { ...data, pages: [{ ...first, items: [post, ...first.items] }, ...rest] });
  }
}

function ideaMatches(params: IdeasListParams | undefined, idea: Idea): boolean {
  if (!params) return true;
  if (params.status && params.status !== idea.status) return false;
  if (params.agentId && params.agentId !== idea.agentId) return false;
  return true;
}

/** Files the memory page shows (and the claims behind them): a change to one refreshes claims and search. */
function isMemoryPath(path: string): boolean {
  return path === "MEMORY.md" || path === "ALIGNMENT_SYNTHESIS.md" || path.startsWith("memory/") || path.startsWith("people/");
}

function applyRun(qc: QueryClient, run: Run, todayChanged: boolean): void {
  qc.setQueryData(qk.run(run.id), run);
  const parentId = run.parentRunId;
  if (parentId !== undefined) {
    qc.setQueryData<Run>(qk.run(parentId), (parent) =>
      parent && !parent.childRunIds?.includes(run.id) ? { ...parent, childRunIds: [...(parent.childRunIds ?? []), run.id] } : parent,
    );
  }
  for (const [key, data] of qc.getQueriesData<Run[]>({ queryKey: ["runs"] })) {
    if (!Array.isArray(data)) continue;
    const params = key[1] as RunsListParams | undefined;
    qc.setQueryData<Run[]>(key, runMatches(params, run) ? upsert(data, run) : data.filter((entry) => entry.id !== run.id));
  }
  if (todayChanged) void qc.invalidateQueries({ queryKey: qk.today() });
}

function patchWireRun(qc: QueryClient, runId: string, patch: Partial<Run>): void {
  qc.setQueryData<Run>(qk.run(runId), (old) => (old ? { ...old, ...patch } : old));
  for (const [key, data] of qc.getQueriesData<Run[]>({ queryKey: ["runs"] })) {
    if (!Array.isArray(data)) continue;
    const next = data.map((run) => (run.id === runId ? { ...run, ...patch } : run));
    const params = key[1] as RunsListParams | undefined;
    qc.setQueryData<Run[]>(key, next.filter((run) => runMatches(params, run)));
  }
}

function applyWireTerminal(qc: QueryClient, event: AgentEvent): void {
  if (event.type !== EventType.RUN_FINISHED && event.type !== EventType.RUN_ERROR) return;
  const juno = junoOf(event);
  const runId = juno?.runId ?? (event.type === EventType.RUN_FINISHED ? event.runId : undefined);
  if (runId === undefined) return;
  if (event.type === EventType.RUN_ERROR) {
    patchWireRun(qc, runId, { status: "failed", error: event.message });
    void qc.invalidateQueries({ queryKey: qk.today() });
    return;
  }
  const status: Run["status"] = event.outcome?.type === "cancelled"
    ? "stopped"
    : event.outcome?.type === "interrupt"
      ? "waiting_for_input"
      : "completed";
  patchWireRun(qc, runId, { status });
  if (status !== "waiting_for_input") void qc.invalidateQueries({ queryKey: qk.today() });
}

type ResettableEventSource = EventSource & EventResetSource;

function isResettable(source: EventSource): source is ResettableEventSource {
  return "subscribeReset" in source && typeof source.subscribeReset === "function";
}

/** Reset the cache and the streamed-message state before the server replays from the beginning. */
export function resetLiveState(qc: QueryClient): void {
  resetAguiMessages();
  qc.clear();
}

/** Fold one event into the cache. Exported for tests. */
export function applyEvent(qc: QueryClient, event: AgentEvent): void {
  applyAguiMessageEvent(qc, event);
  switch (event.type) {
    case "agent.status": {
      // The event is a full snapshot: `doing` is replaced too, and cleared once the agent stops working.
      const { agentId, status, doing } = event;
      const apply = (agent: Agent): Agent => {
        const next: Agent = { ...agent, status };
        if (doing === undefined) delete next.doing;
        else next.doing = doing;
        return next;
      };
      qc.setQueryData<Agent>(qk.agent(agentId), (old) => (old ? apply(old) : old));
      patchLists<Agent>(qc, ["agents"], (list) => list.map((a) => (a.id === agentId ? apply(a) : a)));
      break;
    }

    // Full agent snapshots (e.g. a new or accepted/dismissed role suggestion, BACKEND §10.11).
    case "agent.updated": {
      const { agent } = event;
      qc.setQueryData<Agent>(qk.agent(agent.id), agent);
      patchLists<Agent>(qc, ["agents"], (list) => list.map((a) => (a.id === agent.id ? agent : a)));
      break;
    }

    // BACKEND §5.2: a home file changed (user edit or a sync); refetch the home queries.
    case "agent.home.changed": {
      void qc.invalidateQueries({ queryKey: ["home"] });
      if (isMemoryPath(event.path)) void qc.invalidateQueries({ queryKey: ["memory"] });
      break;
    }

    // UI108: a tombstone for a deleted agent drops the row so an SSE replay
    // from cursor 0 cannot resurrect it. Direct conversations of the agent
    // arrive as their own conversation.deleted events.
    case "agent.deleted": {
      const { agentId } = event;
      qc.removeQueries({ queryKey: qk.agent(agentId) });
      patchLists<Agent>(qc, ["agents"], (list) => list.filter((a) => a.id !== agentId));
      break;
    }

    case "computer.state": {
      const { computerId, state, controller } = event;
      qc.setQueryData<Computer>(qk.computer(computerId), (old) =>
        old ? { ...old, state, controller } : old,
      );
      patchLists<Computer>(qc, ["computers"], (list) =>
        list.map((c) => (c.id === computerId ? { ...c, state, controller } : c)),
      );
      break;
    }

    case "control.changed": {
      applyControlChange(qc, event);
      break;
    }

    case "conversation.created": {
      // A direct/room thread made at runtime (the compose draft) joins the chat list at once.
      const conversation = event.conversation;
      qc.setQueryData(qk.conversation(conversation.id), conversation);
      patchLists<Conversation>(qc, ["conversations"], (list) => upsert(list, conversation));
      break;
    }

    // A flag changed (pinned/muted), the chat was read, or a message arrived. Replace a cached row only:
    // this can arrive after conversation.deleted, and must never bring the row back.
    case "conversation.updated": {
      const { conversation } = event;
      qc.setQueryData<Conversation>(qk.conversation(conversation.id), (old) => (old ? conversation : old));
      patchLists<Conversation>(qc, ["conversations"], (list) =>
        list.map((c) => (c.id === conversation.id ? conversation : c)),
      );
      break;
    }

    // UI108: a tombstone for a deleted conversation drops the row and its
    // cached transcript so an SSE replay from cursor 0 cannot resurrect it.
    case "conversation.deleted": {
      const { conversationId } = event;
      qc.removeQueries({ queryKey: qk.conversation(conversationId) });
      qc.removeQueries({ queryKey: qk.items(conversationId) });
      patchLists<Conversation>(qc, ["conversations"], (list) =>
        list.filter((c) => c.id !== conversationId),
      );
      break;
    }

    case EventType.RUN_STARTED:
      void qc.invalidateQueries({ queryKey: qk.today() });
      break;

    case EventType.RUN_FINISHED:
    case EventType.RUN_ERROR:
      applyWireTerminal(qc, event);
      break;

    // STEP_* identifies the durable step but carries no Step row. The whole run arrives in
    // juno.run.updated, so refresh that projection instead of inventing a partial row.
    case EventType.STEP_STARTED:
    case EventType.STEP_FINISHED: {
      const runId = junoOf(event)?.runId;
      if (runId !== undefined) void qc.invalidateQueries({ queryKey: qk.run(runId) });
      break;
    }

    case EventType.TEXT_MESSAGE_START:
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_END:
    case EventType.MESSAGES_SNAPSHOT:
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_END:
    case EventType.TOOL_CALL_RESULT:
    case EventType.ACTIVITY_SNAPSHOT:
    case EventType.ACTIVITY_DELTA:
    case EventType.SUBAGENT_STARTED:
    case EventType.SUBAGENT_FINISHED:
    case EventType.SUBAGENT_ERROR:
      break;

    case EventType.CUSTOM: {
      if (event.name !== "juno.run.updated") break;
      const parsed = runSchema.safeParse(event.value);
      if (parsed.success) applyRun(qc, parsed.data, true);
      break;
    }

    case "item.added": {
      const { conversationId, item } = event;
      qc.setQueryData<Item[]>(qk.items(conversationId), (old) => {
        if (!old) return old;
        // Insert by `at`, not by arrival: a reply generated before a later item can be delivered
        // after it (owner feedback 2026-10-05), and must not render at the end of the transcript.
        return mergeItemChronologically(old, item);
      });
      if (item.type === "artifact") {
        // A delivered file lands in the library: refresh lists and the card's own query so the
        // transcript shows it without waiting for a refetch window.
        void qc.invalidateQueries({ queryKey: ["library"] });
        void qc.invalidateQueries({ queryKey: ["artifact", item.artifactId] });
      }
      if (item.type === "plan") {
        // A plan write (todo_write upsert) changes the authoritative task list for its agent;
        // refetch so the Ongoing tasks pane reflects the new todo state (TODO-LIFECYCLE §UI).
        void qc.invalidateQueries({ queryKey: taskKeys.agentPlansAll });
      }
      break;
    }

    case "artifact.updated": {
      // A new version of a published artifact updates its existing card in place (BACKEND §5.11).
      const { artifact } = event;
      qc.setQueryData<LibraryItem>(["artifact", artifact.id], (old) => (old ? { ...old, ...artifact } : old));
      void qc.invalidateQueries({ queryKey: ["artifact", artifact.id] });
      void qc.invalidateQueries({ queryKey: ["library"] });
      if (artifact.render === "doc") void qc.invalidateQueries({ queryKey: qk.document(artifact.id) });
      break;
    }

    case "document.draft.updated":
      // An agent proposed, the owner saved, or a draft was decided: the document's cached draft follows (BACKEND §5.11a).
      applyDocumentDraftEvent(qc, event.draft);
      break;

    case "request.created": {
      const request = event.request;
      qc.setQueryData<Request>(qk.request(request.id), request);
      for (const [key] of qc.getQueriesData<Request[]>({ queryKey: ["requests"] })) {
        const params = key[1] as RequestsListParams | undefined;
        if (!requestMatches(params, request)) continue;
        qc.setQueryData<Request[]>(key, (old) => upsert(old ?? [], request));
      }
      void qc.invalidateQueries({ queryKey: qk.today() });
      break;
    }

    case "task.updated":
      upsertTask(qc, event.task);
      break;

    case "request.resolved": {
      const request = event.request;
      void qc.invalidateQueries({ queryKey: taskKeys.requestHistoryAll });
      // "Allow this kind" creates delegations as it resolves.
      void qc.invalidateQueries({ queryKey: qk.delegations() });
      qc.setQueryData<Request>(qk.request(request.id), request);
      for (const [key] of qc.getQueriesData<Request[]>({ queryKey: ["requests"] })) {
        const params = key[1] as RequestsListParams | undefined;
        qc.setQueryData<Request[]>(key, (old) =>
          (old ?? []).flatMap((entry) => {
            if (entry.id !== request.id) return [entry];
            return requestMatches(params, request) ? [request] : [];
          }),
        );
      }
      void qc.invalidateQueries({ queryKey: qk.today() });
      break;
    }

    // An accepted or dismissed idea leaves the open list; a newly offered one joins it.
    case "idea.updated": {
      const idea = event.idea;
      for (const [key, data] of qc.getQueriesData<Idea[]>({ queryKey: ["ideas"] })) {
        if (!Array.isArray(data)) continue;
        const params = key[1] as IdeasListParams | undefined;
        qc.setQueryData<Idea[]>(key, ideaMatches(params, idea) ? upsert(data, idea) : data.filter((entry) => entry.id !== idea.id));
      }
      break;
    }

    case "routine.updated": {
      const routine = event.routine;
      qc.setQueryData<Routine>(qk.routine(routine.id), routine);
      patchLists<Routine>(qc, ["routines"], (list) => upsert(list, routine));
      break;
    }

    case "goal.updated": {
      const goal = event.goal;
      // The event carries no activity timeline unless the server adds one: keep the cached timeline.
      qc.setQueryData<Goal>(qk.goal(goal.id), (old) => ({ ...old, ...goal, activity: goal.activity ?? old?.activity }));
      if (!goal.activity) void qc.invalidateQueries({ queryKey: qk.goal(goal.id) });
      for (const [key, data] of qc.getQueriesData<Goal[]>({ queryKey: prefix.goals })) {
        if (!Array.isArray(data)) continue;
        const params = key[1] as GoalsListParams | undefined;
        qc.setQueryData<Goal[]>(key, goalMatches(params, goal) ? upsert(data, goal) : data.filter((entry) => entry.id !== goal.id));
      }
      break;
    }

    case "goal.deleted": {
      const { goalId } = event;
      qc.removeQueries({ queryKey: qk.goal(goalId) });
      patchLists<Goal>(qc, prefix.goals, (list) => list.filter((entry) => entry.id !== goalId));
      break;
    }

    case "feed.created": {
      prependFeedPost(qc, event.post);
      void qc.invalidateQueries({ queryKey: qk.today() });
      break;
    }

    // A routine finished a run with feed posts: refetch the feed and Today's brief.
    case "feed.brief": {
      void qc.invalidateQueries({ queryKey: prefix.feed });
      void qc.invalidateQueries({ queryKey: qk.today() });
      break;
    }

    case "feed.updated": {
      const post = event.post;
      updateFeedPost(qc, post.id, () => post);
      break;
    }

  }
}

/** Mount once inside the providers: keeps the cache warm from the live stream. */
export function useLiveSync(): void {
  const events = useEventSource();
  const qc = useQueryClient();
  const identity = useAuthIdentity();
  const identityKey = identity ? identity.mode + (identity.user?.id ?? "") : "anonymous";

  useEffect(() => {
    // Streamed-message state is per-account memory: never carry it across a sign-out or account switch.
    resetAguiMessages();
  }, [identityKey]);

  useEffect(() => {
    if (!events) return;
    return events.subscribe((event) => applyEvent(qc, event));
  }, [events, qc]);

  useEffect(() => {
    if (!events || !isResettable(events)) return;
    return events.subscribeReset(() => resetLiveState(qc));
  }, [events, qc]);
}
