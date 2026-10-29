import type { AgentTask } from "@agent-desktop/client";
import type { StatusPillProps } from "@agent-desktop/ui";
import { t } from "./i18n";
import { progressText } from "./stepLine";

/**
 * How a task reads on every surface (the iPhone and Android apps use the same words): one label per `status` +
 * `waitingFor` + `outcome`, a line for `outcomeDetail`, where a tap on it goes, and the tree the list is grouped
 * into. The server decides the state; nothing here infers it from text.
 */
export type TaskTone = NonNullable<StatusPillProps["tone"]>;

/** The pill: tone and the status words. */
export function taskPhase(task: AgentTask): { tone: TaskTone; label: string } {
  switch (task.status) {
    case "queued":
      return { tone: "neutral", label: t("tasks.status.queued") };
    case "running":
      return { tone: "success", label: t("tasks.status.running") };
    case "waiting":
      return { tone: "warning", label: t(`tasks.status.waiting.${task.waitingFor ?? "owner_input"}`) };
    case "ended":
      switch (task.outcome) {
        case "failed":
          return { tone: "danger", label: t("tasks.status.failed") };
        case "cancelled":
          return { tone: "neutral", label: t("tasks.status.cancelled") };
        case "needs_input":
          return { tone: "warning", label: t("tasks.status.needsInput") };
        case "unknown_effect":
          return { tone: "warning", label: t("tasks.status.unknownEffect") };
        default:
          return { tone: "success", label: t("tasks.status.done") };
      }
  }
}

/** The specific reason behind an outcome, in words (nothing when the task has none). `agentName` is the agent that stopped it, for "Stopped by <agent>". */
export function taskDetailText(task: AgentTask, agentName?: string): string | undefined {
  if (task.outcomeDetail === undefined) return undefined;
  if (task.outcomeDetail === "stopped_by_agent") return t("tasks.detail.stopped_by_agent", { agent: agentName ?? t("tasks.detail.theAgent") });
  return t(`tasks.detail.${task.outcomeDetail}`);
}

/** The second line of a task row: what it is doing now, the question it waits on, or how it ended. */
export function taskSubtitle(task: AgentTask, agentName?: string): string {
  switch (task.status) {
    case "queued":
      return task.outcomeDetail === "dispatch_failed" ? t("tasks.detail.dispatchFailedRetry") : t("tasks.status.queued");
    case "running":
      return task.progress ? progressText(task.progress) : t("tasks.working");
    case "waiting":
      return task.progress ? `${taskPhase(task).label} · ${progressText(task.progress)}` : taskPhase(task).label;
    case "ended": {
      const lines = [taskDetailText(task, agentName), task.resultLine].filter((line): line is string => Boolean(line));
      return lines.length > 0 ? [...new Set(lines)].join(" · ") : taskPhase(task).label;
    }
  }
}

/** Running, waiting or queued: the task is still on the Now list. */
export const isLiveTask = (task: AgentTask): boolean => task.status !== "ended";

/**
 * The conversation to open when a task needs the person: a question or approval it waits on (`owner_input`,
 * `approval`), a recovery review of an action that may have happened (`effect_review`, `unknown_effect`), or an
 * ended `needs_input`. That conversation holds the request card.
 */
export function taskNeedsYou(task: AgentTask): { conversationId: string } | undefined {
  const needs = (task.status === "waiting" && task.waitingFor !== "event") || task.outcome === "needs_input" || task.outcome === "unknown_effect";
  return needs && task.conversationId !== undefined ? { conversationId: task.conversationId } : undefined;
}

export interface TaskNode {
  task: AgentTask;
  children: TaskNode[];
}

/** How urgent a task's need for the person is: approval 4, a question 3, a review or unknown outcome 2, ended needing input 1, else 0. */
function needsYouRank(task: AgentTask): number {
  if (task.status === "waiting") return task.waitingFor === "approval" ? 4 : task.waitingFor === "effect_review" ? 2 : task.waitingFor === "event" ? 0 : 3;
  if (task.outcome === "unknown_effect") return 2;
  return task.outcome === "needs_input" ? 1 : 0;
}

function flattenNode(node: TaskNode): AgentTask[] {
  return [node.task, ...node.children.flatMap(flattenNode)];
}

/** True when the task or anything under it needs the person (such children list first, so a cap never hides them). */
export const subtreeNeedsYou = (node: TaskNode): boolean => flattenNode(node).some((task) => needsYouRank(task) > 0);

/**
 * What a folded parent must not hide: the tasks anywhere below it that need the person, how many, and the most urgent one's
 * pill (same words and tone as that task). Nothing when no descendant needs the person.
 */
export function descendantsNeedingYou(node: TaskNode): { phase: { tone: TaskTone; label: string }; line: string } | undefined {
  const below = node.children.flatMap(flattenNode).filter((task) => needsYouRank(task) > 0);
  const top = below.reduce<AgentTask | undefined>((best, task) => (best === undefined || needsYouRank(task) > needsYouRank(best) ? task : best), undefined);
  if (top === undefined) return undefined;
  return { phase: taskPhase(top), line: below.length === 1 ? t("tasks.needsYouOne") : t("tasks.needYouMany", { count: below.length }) };
}

/** What a task's children point at: its own id, the run it is (subagent: `childRunId`; routine run: `runId`). */
function parentKeys(task: AgentTask): string[] {
  return [task.id, task.childRunId, task.kind === "routine" ? task.runId : undefined].filter((key): key is string => key !== undefined);
}

/**
 * Group tasks by `parentId`. A task whose parent is not in the list is top-level (a plain chat run is a tree root
 * but never a task). Children are oldest first; top-level nodes keep the order given.
 */
export function buildTaskTree(tasks: readonly AgentTask[]): TaskNode[] {
  const nodes = tasks.map((task): TaskNode => ({ task, children: [] }));
  const byKey = new Map<string, TaskNode>();
  for (const node of nodes) for (const key of parentKeys(node.task)) byKey.set(key, node);
  const top: TaskNode[] = [];
  for (const node of nodes) {
    const parent = node.task.parentId === undefined ? undefined : byKey.get(node.task.parentId);
    if (parent === undefined || parent === node) top.push(node);
    else parent.children.push(node);
  }
  for (const node of nodes) node.children.sort((a, b) => a.task.startedAt.localeCompare(b.task.startedAt));
  // Tasks that point at each other in a loop never reach the top; show them there rather than lose them.
  const reached = new Set<TaskNode>();
  const visit = (node: TaskNode): void => {
    if (reached.has(node)) return;
    reached.add(node);
    node.children.forEach(visit);
  };
  top.forEach(visit);
  return [...top, ...nodes.filter((node) => !reached.has(node))];
}

/** A top-level row of the list: a task with its subtree, or a routine with its runs. */
export type TaskEntry = { type: "task"; node: TaskNode } | { type: "routine"; routineId: string; runs: TaskNode[] };

/** Routine runs gather under their routine (at the first run's position); everything else stays a task entry. */
export function groupTaskEntries(tasks: readonly AgentTask[]): TaskEntry[] {
  const entries: TaskEntry[] = [];
  const routines = new Map<string, Extract<TaskEntry, { type: "routine" }>>();
  for (const node of buildTaskTree(tasks)) {
    const routineId = node.task.kind === "routine" ? node.task.routineId : undefined;
    if (routineId === undefined) {
      entries.push({ type: "task", node });
      continue;
    }
    const group = routines.get(routineId);
    if (group) group.runs.push(node);
    else {
      const created = { type: "routine" as const, routineId, runs: [node] };
      routines.set(routineId, created);
      entries.push(created);
    }
  }
  return entries;
}

const flatten = (node: TaskNode): AgentTask[] => [node.task, ...node.children.flatMap(flatten)];

/** Every task inside an entry. */
export const entryTasks = (entry: TaskEntry): AgentTask[] => (entry.type === "task" ? flatten(entry.node) : entry.runs.flatMap(flatten));

/** An entry is live while anything inside it is. */
export const entryIsLive = (entry: TaskEntry): boolean => entryTasks(entry).some(isLiveTask);

/** The newest start or update inside an entry: orders live entries (by start) and finished ones (by update). */
export const entryLatest = (entry: TaskEntry, field: "startedAt" | "updatedAt"): string =>
  entryTasks(entry).reduce((latest, task) => (task[field] > latest ? task[field] : latest), "");
