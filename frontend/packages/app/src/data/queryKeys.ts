/**
 * Query keys for an agent's task list and todo plans. Kept beside `keys.ts` because both endpoints
 * are agent-scoped and invalidated or patched as a whole prefix when a live event streams in.
 */
export const taskKeys = {
  /** `agents.tasks`: the tasks list (running, waiting, finished); patched by `task.updated`. */
  agentTasks: (agentId: string) => ["agentTasks", agentId] as const,
  agentTasksAll: ["agentTasks"] as const,
  /** `agents.plans`: the latest todo plan per conversation; refetched when a plan item streams in. */
  agentPlans: (agentId: string) => ["agentPlans", agentId] as const,
  agentPlansAll: ["agentPlans"] as const,
  /** Resolved requests of one agent, newest first, paged. */
  requestHistory: (agentId: string, filters: object = {}) => ["requestHistory", agentId, filters] as const,
  requestHistoryAll: ["requestHistory"] as const,
  /** A request's screenshot bytes (library download), by library id. */
  requestPreview: (libraryId: string) => ["requestPreview", libraryId] as const,
};
