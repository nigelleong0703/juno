import type { Agent, AgentTask, WorkKind } from "@agent-desktop/client";
import { Button, cn, ListRow, Section, StatusPill } from "@agent-desktop/ui";
import { Bot, CalendarClock, ChevronDown, ChevronRight, Clock, Plug, Sparkles, Square, Terminal } from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import { useNavigate } from "react-router";
import { ComputerPane } from "../../../components/computer";
import { LiveRequestCard } from "../../../components/request/LiveRequestCard";
import { useAgent, usePendingRequests, useRoutines } from "../../../data/queries";
import { taskRunId, useAgentTaskList, useMoreEndedTasks, useStopTask } from "../../../data/tasks";
import { startedByLine } from "../../../lib/auditInitiator";
import { t } from "../../../lib/i18n";
import {
  entryIsLive,
  entryLatest,
  groupTaskEntries,
  descendantsNeedingYou,
  subtreeNeedsYou,
  taskNeedsYou,
  taskSubtitle,
  type TaskEntry,
  type TaskNode,
} from "../../../lib/taskView";
import { TaskCard } from "./TaskCard";
import { dayLabel, isToday, ShowMore, TASKS_PAGE, timeLabel, useCapped } from "./parts";

/** Quiet line for an empty tab. */
function Empty({ children }: { children: string }) {
  return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

/** Items grouped under "Today", "Yesterday", or a date, in the order given. */
function groupByDay<T>(items: T[], at: (item: T) => string): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(at(item));
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

const TASK_ICON: Record<WorkKind, ComponentType<{ className?: string }>> = {
  task: Sparkles,
  subagent: Bot,
  routine: CalendarClock,
  command: Terminal,
  connector: Plug,
  wait: Clock,
};

/** What a row does when tapped: go to the request card of a task that needs the person, else open the task card. */
type OpenTask = (task: AgentTask) => (() => void) | undefined;

/** Children under a parent show a few at a time; the rest sit behind "Show more". */
const CHILDREN_PAGE = 5;

/** The "N tasks" / "N runs" toggle at the end of a row that has more underneath. */
function ExpandToggle({ label, expanded, onToggle }: { label: string; expanded: boolean; onToggle: () => void }) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {label}
      <Chevron className="size-3.5" />
    </Button>
  );
}

/** One task row: icon tile, title, muted status line, time and who started it, Stop while it runs, and the toggle for its children. */
function TaskRow({
  task,
  onOpen,
  toggle,
  nested = false,
  below,
}: {
  task: AgentTask;
  onOpen?: (() => void) | undefined;
  toggle?: React.ReactNode;
  nested?: boolean;
  /** Set on a parent with a descendant that needs the person: the pill and the "N need you" line. */
  below?: ReturnType<typeof descendantsNeedingYou>;
}) {
  const stop = useStopTask();
  const { data: agent } = useAgent(task.agentId);
  const Icon = TASK_ICON[task.kind];
  const active = task.status !== "ended";
  const needsYou = task.status === "waiting" || task.outcome === "needs_input" || task.outcome === "unknown_effect";
  return (
    <ListRow
      className={active ? "bg-muted" : undefined}
      leading={
        <span className={cn("grid size-9 place-items-center rounded-[10px] text-muted-foreground", active ? "bg-background" : "bg-muted")} title={t(`tasks.kind.${task.kind}`)}>
          <Icon className="size-[18px]" />
        </span>
      }
      title={task.title}
      description={
        <>
          {below ? <StatusPill tone={below.phase.tone}>{below.phase.label}</StatusPill> : null}
          {below ? <span className="block text-warning">{below.line}</span> : null}
          <span className={needsYou ? "text-warning" : undefined}>{taskSubtitle(task, agent?.name)}</span>
          <span className="block">{nested ? timeLabel(task.startedAt) : `${timeLabel(task.startedAt)} · ${startedByLine(task.origin)}`}</span>
        </>
      }
      onClick={onOpen}
      trailing={
        <>
          {toggle}
          {task.status === "running" ? (
            <button
              type="button"
              aria-label={t("agentTasks.stop", { title: task.title })}
              disabled={stop.isPending}
              onClick={(event) => {
                event.stopPropagation();
                stop.mutate(task.id);
              }}
              className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-50 focus-ring"
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : null}
        </>
      }
    />
  );
}

/** A task with its children folded underneath: the count opens them, a few at a time. */
function TaskTreeRow({ node, open, nested = false }: { node: TaskNode; open: OpenTask; nested?: boolean }) {
  const below = descendantsNeedingYou(node);
  // A group with a descendant that needs the person starts open, and lists those children first.
  const [expanded, setExpanded] = useState(below !== undefined);
  const children = useMemo(() => [...node.children].sort((a, b) => Number(subtreeNeedsYou(b)) - Number(subtreeNeedsYou(a))), [node.children]);
  const capped = useCapped(children, CHILDREN_PAGE);
  const count = node.children.length;
  return (
    <>
      <TaskRow
        task={node.task}
        below={below}
        onOpen={open(node.task)}
        nested={nested}
        toggle={count > 0 ? <ExpandToggle label={t("tasks.stepCount", { count })} expanded={expanded} onToggle={() => setExpanded((value) => !value)} /> : undefined}
      />
      {expanded ? (
        <div className="ml-6 flex flex-col">
          {capped.shown.map((child) => (
            <TaskTreeRow key={child.task.id} node={child} open={open} nested />
          ))}
          <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
        </div>
      ) : null}
    </>
  );
}

/** Routine runs under their routine: its name, how many runs, the newest run's state; the runs open underneath. */
function RoutineRow({ title, runs, open }: { title: string; runs: TaskNode[]; open: OpenTask }) {
  const [expanded, setExpanded] = useState(false);
  const capped = useCapped(runs, CHILDREN_PAGE);
  const newest = runs[0]?.task;
  const { data: newestAgent } = useAgent(newest?.agentId);
  const live = runs.some((run) => run.task.status !== "ended");
  return (
    <>
      <ListRow
        className={live ? "bg-muted" : undefined}
        leading={
          <span className={cn("grid size-9 place-items-center rounded-[10px] text-muted-foreground", live ? "bg-background" : "bg-muted")} title={t("tasks.kind.routine")}>
            <CalendarClock className="size-[18px]" />
          </span>
        }
        title={title}
        description={newest ? <span>{taskSubtitle(newest, newestAgent?.name)}</span> : undefined}
        onClick={() => setExpanded((value) => !value)}
        trailing={<ExpandToggle label={t("tasks.routineRuns", { count: runs.length })} expanded={expanded} onToggle={() => setExpanded((value) => !value)} />}
      />
      {expanded ? (
        <div className="ml-6 flex flex-col">
          {capped.shown.map((run) => (
            <TaskTreeRow key={run.task.id} node={run} open={open} nested />
          ))}
          <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
        </div>
      ) : null}
    </>
  );
}

/** The rows of a list of entries: a task with its subtree, or a routine with its runs. */
function TaskEntryRows({ entries, open }: { entries: TaskEntry[]; open: OpenTask }) {
  const { data: routines } = useRoutines();
  return (
    <>
      {entries.map((entry) =>
        entry.type === "task" ? (
          <TaskTreeRow key={entry.node.task.id} node={entry.node} open={open} />
        ) : (
          <RoutineRow key={entry.routineId} title={routines?.find((routine) => routine.id === entry.routineId)?.name ?? t("tasks.kind.routine")} runs={entry.runs} open={open} />
        ),
      )}
    </>
  );
}

/** An agent's tasks as top-level entries (a task with its subtree, a routine with its runs): live ones (newest first) and finished ones (latest first). */
function useTaskGroups(agentId: string): { active: TaskEntry[]; finished: TaskEntry[]; isLoading: boolean } {
  const { data: tasks, isLoading } = useAgentTaskList(agentId);
  const { active, finished } = useMemo(() => {
    const entries = groupTaskEntries(tasks ?? []);
    return {
      active: entries.filter(entryIsLive).sort((a, b) => entryLatest(b, "startedAt").localeCompare(entryLatest(a, "startedAt"))),
      finished: entries.filter((entry) => !entryIsLive(entry)).sort((a, b) => entryLatest(b, "updatedAt").localeCompare(entryLatest(a, "updatedAt"))),
    };
  }, [tasks]);
  return { active, finished, isLoading };
}

/** Tapping a row: a task that needs the person goes to the conversation holding its request card; any other opens its task card. */
function useOpenTask(setOpenRunId: (runId: string) => void, allowConversation: boolean): OpenTask {
  const navigate = useNavigate();
  return (task) => {
    const needs = taskNeedsYou(task);
    if (needs) return () => void navigate(`/c/${needs.conversationId}`);
    const runId = taskRunId(task);
    if (runId) return () => setOpenRunId(runId);
    // A task without a run (a meeting) opens the thread it lives in.
    return allowConversation && task.conversationId ? () => void navigate(`/c/${task.conversationId}`) : undefined;
  };
}

/**
 * Activity: the agent's tasks like Muse's list. Live rows come first under "Now", highlighted, the running ones with a
 * round Stop; finished ones follow grouped by day. A task with helpers folds them under a count, routine runs sit
 * under their routine. Capped at 20 with "Show more", which then fetches older pages; `task.updated` keeps it live.
 */
export function ActivityTab({ agent }: { agent: Agent }) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const { active, finished, isLoading } = useTaskGroups(agent.id);
  const older = useMoreEndedTasks(agent.id);
  const { data: pending } = usePendingRequests();
  const waiting = (pending ?? []).filter((request) => request.agentId === agent.id);
  const waitingCapped = useCapped(waiting, 3);
  const capped = useCapped(finished, TASKS_PAGE);
  const open = useOpenTask(setOpenRunId, false);
  if (isLoading) return <Empty>{t("common.loading")}</Empty>;
  if (active.length + finished.length + waiting.length === 0) {
    return (
      <div className="px-2">
        <Empty>{t("agentTasks.empty")}</Empty>
      </div>
    );
  }

  return (
    <div className="space-y-4 px-2">
      {active.length + waiting.length > 0 ? (
        <Section title={t("tasks.now")} className="gap-1" contentClassName="flex flex-col gap-1">
          {waitingCapped.shown.map((request) => (
            <LiveRequestCard key={request.id} request={request} />
          ))}
          <ShowMore hidden={waitingCapped.hidden} onClick={waitingCapped.showMore} />
          <TaskEntryRows entries={active} open={open} />
        </Section>
      ) : null}
      {groupByDay(capped.shown, (entry: TaskEntry) => entryLatest(entry, "updatedAt")).map((group) => (
        <Section key={group.label} title={group.label} className="gap-1" contentClassName="flex flex-col">
          <TaskEntryRows entries={group.items} open={open} />
        </Section>
      ))}
      <ShowMore hidden={capped.hidden} more={capped.hidden === 0 && older.hasMore} onClick={capped.hidden > 0 ? capped.showMore : older.loadMore} />
      <TaskCard runId={openRunId} onClose={() => setOpenRunId(null)} />
    </div>
  );
}

/** Computer: this agent's own screen, the production live screen (take over and return stay in it). */
export function ComputerTab({ agent, conversationId }: { agent: Agent; conversationId?: string }) {
  return (
    <div className="overflow-hidden rounded-xl">
      <ComputerPane bare agentId={agent.id} screenAgentId={agent.id} {...(conversationId ? { conversationId } : {})} className="h-auto" />
    </div>
  );
}

/** Rows of finished tasks the workspace shows before "Show more". */
const WORKSPACE_FINISHED_PAGE = 5;

/**
 * Under the live screen in the workspace: what this agent is doing now (live tasks) and what it finished today, the
 * same rows as Activity; a row opens the task card, or the conversation when it needs the person.
 */
export function WorkspaceTasks({ agent }: { agent: Agent }) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const { active, finished } = useTaskGroups(agent.id);
  const activeCapped = useCapped(active);
  const today = useCapped(useMemo(() => finished.filter((entry) => isToday(entryLatest(entry, "updatedAt"))), [finished]), WORKSPACE_FINISHED_PAGE);
  const open = useOpenTask(setOpenRunId, true);
  if (active.length + today.shown.length === 0) return null;
  return (
    // Headings sit on the same inset as the rows' icons (ListRow pads its content by 8px).
    <div className="space-y-4 px-2 pb-4 pt-3 [&_[data-slot=section]_h2]:px-2">
      {active.length > 0 ? (
        <Section title={t("tasks.now")} className="gap-1" contentClassName="flex flex-col gap-1">
          <TaskEntryRows entries={activeCapped.shown} open={open} />
          <ShowMore hidden={activeCapped.hidden} onClick={activeCapped.showMore} />
        </Section>
      ) : null}
      {today.shown.length > 0 ? (
        <Section title={t("time.today")} className="gap-1" contentClassName="flex flex-col">
          <TaskEntryRows entries={today.shown} open={open} />
          <ShowMore hidden={today.hidden} onClick={today.showMore} />
        </Section>
      ) : null}
      <TaskCard runId={openRunId} onClose={() => setOpenRunId(null)} />
    </div>
  );
}
