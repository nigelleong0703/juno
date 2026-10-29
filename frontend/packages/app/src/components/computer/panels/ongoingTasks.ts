import type { PlanItem, Todo } from "@agent-desktop/client";

export interface OngoingTask {
  planId: string;
  conversationId: string;
  todo: Todo;
}

/**
 * Flatten the unfinished todos of the authoritative latest plan per conversation (TODO-LIFECYCLE).
 * Plans owned by another agent are dropped defensively, and done todos never surface — so a task
 * stays listed across a finished/stopped run and disappears only once its todo is done.
 */
export function selectOngoingTasks(plans: PlanItem[], agentId: string): OngoingTask[] {
  const latest = new Map<string, PlanItem>();
  for (const plan of plans) {
    if (plan.agentId && plan.agentId !== agentId) continue;
    const kept = latest.get(plan.conversationId);
    if (kept && kept.at >= plan.at) continue;
    latest.set(plan.conversationId, plan);
  }
  const ordered = [...latest.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
  return ordered.flatMap((plan) =>
    plan.todos
      .filter((todo) => todo.status !== "done")
      .map((todo) => ({ planId: plan.id, conversationId: plan.conversationId, todo })),
  );
}
