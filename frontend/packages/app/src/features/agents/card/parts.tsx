import type { Agent } from "@agent-desktop/client";
import { Button } from "@agent-desktop/ui";
import { useState } from "react";
import { useRuns } from "../../../data/queries";
import { useAgentTaskList } from "../../../data/tasks";
import { t } from "../../../lib/i18n";
import { progressText } from "../../../lib/stepLine";
import { ACTIVE_RUN, resolveDoingLine } from "../../../lib/doingLine";
import { usePlannedFeatures } from "../../../lib/plannedFeatures";

export { ACTIVE_RUN };

/**
 * "What is it doing" for one agent: the progress line of its newest running task (the line Muse
 * shows under the avatar), else the shared `resolveDoingLine` (only while working or needing you).
 */
export function useDoingLine(agent: Pick<Agent, "id" | "doing" | "status">): string | undefined {
  return useAgentActivity(agent).doing;
}

/** The doing line plus whether the agent is working now (status `working`, a running task or a running top-level run), as the iPhone's `isWorking`. */
export function useAgentActivity(agent: Pick<Agent, "id" | "doing" | "status">): { doing: string | undefined; working: boolean } {
  const planned = usePlannedFeatures();
  const { data: runs } = useRuns({ agentId: agent.id });
  const { data: tasks } = useAgentTaskList(agent.id);
  const running = tasks?.filter((task) => task.status === "running").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const doing =
    ((running?.progress ? progressText(running.progress) : undefined) ?? running?.title) ||
    resolveDoingLine({
      agentId: agent.id,
      status: agent.status,
      planned: planned?.doing[agent.id],
      agentDoing: agent.doing,
      runs,
    });
  const working =
    agent.status === "working" || running !== undefined || (runs ?? []).some((run) => run.agentId === agent.id && run.parentRunId === undefined && (run.status === "running" || run.status === "queued"));
  return { doing, working };
}

/** "Today", "Yesterday" or a short date, for grouping a timeline. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const day = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(now) - start(day)) / 86_400_000);
  if (diff === 0) return t("time.today");
  if (diff === 1) return t("time.yesterday");
  return day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const isToday = (iso: string, now: Date = new Date()): boolean => new Date(iso).toDateString() === now.toDateString();

/** Rows shown before "Show more": every list in the card is capped, never silently cut off. */
export const CARD_PAGE = 10;

/** Task lists show more rows before "Show more" (they are the card's main list). */
export const TASKS_PAGE = 20;

/** The first `shown` items of a list, and a way to show `CARD_PAGE` more. */
export function useCapped<T>(items: readonly T[], page: number = CARD_PAGE): { shown: T[]; hidden: number; showMore: () => void } {
  const [limit, setLimit] = useState(page);
  return {
    shown: items.slice(0, limit),
    hidden: Math.max(0, items.length - limit),
    showMore: () => setLimit((value) => value + page),
  };
}

/** "Show more (n)" while `hidden` rows are cut off; `more` keeps it up, without a count, while the server has older pages. */
export function ShowMore({ hidden, more = false, onClick }: { hidden: number; more?: boolean; onClick: () => void }) {
  if (hidden <= 0 && !more) return null;
  return (
    <div className="flex justify-center pt-1">
      <Button variant="ghost" size="sm" onClick={onClick}>
        {t("common.showMore")}
        {hidden > 0 ? ` (${hidden})` : ""}
      </Button>
    </div>
  );
}

export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
