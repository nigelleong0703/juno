import type { Goal, GoalMilestoneStatus, GoalStatus } from "@agent-desktop/client";
import type { StatusTone } from "@agent-desktop/ui";
import { t } from "../../lib/i18n";

/** Tone for a goal's status pill: done reads as success, paused as neutral-warning. */
export const goalStatusTone: Record<GoalStatus, StatusTone> = {
  active: "info",
  paused: "warning",
  done: "success",
};

export const milestoneTone: Record<GoalMilestoneStatus, StatusTone> = {
  todo: "neutral",
  doing: "info",
  done: "success",
  blocked: "danger",
};

/** "2/5 milestones" (the agent's plan) or "2/5 steps" (the checklist), or nothing when the goal has neither. */
export function goalsProgress(goal: Goal): string | undefined {
  if (goal.milestones?.length) {
    const doing = goal.milestones.filter((item) => item.status === "doing").length;
    const base = t("goals.progressMilestones", { done: goal.milestones.filter((item) => item.status === "done").length, total: goal.milestones.length });
    return doing ? base + t("goals.progressDoing", { n: doing }) : base;
  }
  if (!goal.steps?.length) return undefined;
  const done = goal.steps.filter((step) => step.done).length;
  return t("goals.progress", { done, total: goal.steps.length });
}
