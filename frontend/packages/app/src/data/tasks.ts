import type { AgentTask, DecisionCategory, PlanItem, Request, RequestOutcome } from "@agent-desktop/client";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { taskKeys } from "./queryKeys";

/**
 * Authoritative todo plans for one agent: the latest plan per conversation (TODO-LIFECYCLE).
 * Reads `agents.plans`; run history is never used to invent tasks. The caller flattens the
 * unfinished todos, so plans survive a finished or stopped run and vanish only when all done.
 */
export function useAgentPlans(agentId: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: taskKeys.agentPlans(agentId ?? ""),
    queryFn: async (): Promise<PlanItem[]> => {
      if (!agentId) return [];
      const { items } = await client.agents.plans(agentId);
      return items;
    },
    enabled: Boolean(agentId),
  });
}

/** The cached task list of one agent: the live tasks whole plus the ended ones loaded so far, and where the next ended page starts. */
export type TaskPage = { items: AgentTask[]; nextCursor: string | null };

function useAgentTaskPage<T>(agentId: string | undefined, select: (page: TaskPage) => T) {
  const client = useClient();
  return useQuery({
    queryKey: taskKeys.agentTasks(agentId ?? ""),
    queryFn: async (): Promise<TaskPage> => {
      const { items, nextCursor } = await client.agents.tasks(agentId as string);
      return { items, nextCursor };
    },
    select,
    enabled: Boolean(agentId),
  });
}

const pageItems = (page: TaskPage): AgentTask[] => page.items;
const pageCursor = (page: TaskPage): string | null => page.nextCursor;

/** The agent's task list (`agents.tasks`): live tasks whole, then the newest ended ones. `task.updated` upserts into it. */
export function useAgentTaskList(agentId: string | undefined) {
  return useAgentTaskPage(agentId, pageItems);
}

/** Older ended tasks, one page at a time: `hasMore` while the server has more, `loadMore` appends the next page to the cached list. */
export function useMoreEndedTasks(agentId: string): { hasMore: boolean; loadMore: () => void; isLoadingMore: boolean } {
  const client = useClient();
  const qc = useQueryClient();
  const { data: cursor } = useAgentTaskPage(agentId, pageCursor);
  const more = useMutation({
    mutationFn: (from: string) => client.tasks.list({ agentId, status: "ended", cursor: from }),
    onSuccess: (next) => qc.setQueryData<TaskPage>(taskKeys.agentTasks(agentId), (old) => appendEnded(old, next)),
  });
  return { hasMore: Boolean(cursor), loadMore: () => cursor && more.mutate(cursor), isLoadingMore: more.isPending };
}

/** Add a page of older ended tasks after the cached ones (a task already cached stays as is) and move the cursor on. */
export function appendEnded(old: TaskPage | undefined, next: TaskPage): TaskPage | undefined {
  if (!old) return old;
  const known = new Set(old.items.map((task) => task.id));
  return { items: [...old.items, ...next.items.filter((task) => !known.has(task.id))], nextCursor: next.nextCursor };
}

/** The run behind a task: its own child run for a subagent, else the run that started it. */
export const taskRunId = (task: AgentTask): string | undefined => task.childRunId ?? task.runId;

/** The agent task that belongs to this run, if any (the iPhone: `tasks.first { $0.runId == runId }`). */
export function useTaskForRun(agentId: string | undefined, runId: string | undefined): AgentTask | undefined {
  const { data: tasks } = useAgentTaskList(agentId);
  return runId === undefined ? undefined : tasks?.find((task) => taskRunId(task) === runId);
}

/** Stop a running task; the returned task (and the `task.updated` event) replace the cached row. */
export function useStopTask() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.tasks.stop(id),
    onSuccess: (task) => upsertTask(qc, task),
  });
}

/** Insert or replace one task by id in its agent's cached list (new tasks join the front). */
export function upsertTask(qc: ReturnType<typeof useQueryClient>, task: AgentTask): void {
  qc.setQueryData<TaskPage>(taskKeys.agentTasks(task.agentId), (old) => upsertInPage(old, task));
}

/** The page with `task` replacing the entry of the same id, or joining the front. */
export function upsertInPage(old: TaskPage | undefined, task: AgentTask): TaskPage | undefined {
  if (!old) return old;
  const items = old.items.some((entry) => entry.id === task.id)
    ? old.items.map((entry) => (entry.id === task.id ? task : entry))
    : [task, ...old.items];
  return { ...old, items };
}

/** The agent's decided requests, newest first, one backend page at a time. */
export function useRequestHistory(agentId: string, pageSize = 10, filters: { category?: DecisionCategory; outcome?: RequestOutcome } = {}) {
  const client = useClient();
  return useInfiniteQuery({
    queryKey: taskKeys.requestHistory(agentId, filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<{ items: Request[]; nextCursor: string | null }> =>
      client.requests.list({ agentId, status: "resolved", limit: pageSize, ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** The screenshot an approval carries, as a data URL (the library download is authenticated JSON). */
export function useRequestPreview(libraryId: string | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: taskKeys.requestPreview(libraryId ?? ""),
    queryFn: async () => {
      const file = await client.library.download(libraryId as string);
      return `data:${file.mimeType};base64,${file.contentBase64}`;
    },
    enabled: Boolean(libraryId),
    staleTime: Infinity,
  });
}
