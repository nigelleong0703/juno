import type { CreateGoalInput, Goal, UpdateGoalInput } from "@agent-desktop/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { prefix, qk } from "./keys";

/** Create a goal for one of the user's agents (`POST /v1/goals`). */
export function useCreateGoal() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateGoalInput) => client.goals.create(input),
    onSettled: () => void qc.invalidateQueries({ queryKey: prefix.goals }),
  });
}

/** Edit a goal (title, summary, category, steps, status). The detail is refreshed from the reply. */
export function useUpdateGoal() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateGoalInput }) => client.goals.update(id, patch),
    onSuccess: (goal: Goal) => {
      // The reply has no activity timeline unless the server adds it; keep the one we already have.
      qc.setQueryData<Goal>(qk.goal(goal.id), (old) => ({ ...old, ...goal, activity: goal.activity ?? old?.activity }));
    },
    // The timeline is only served by GET /v1/goals/:id, so refetch the detail to show the new entry.
    onSettled: (_goal, _error, vars) => {
      void qc.invalidateQueries({ queryKey: qk.goal(vars.id) });
      void qc.invalidateQueries({ queryKey: prefix.goals });
    },
  });
}

export function useDeleteGoal() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.goals.delete(id),
    onSuccess: (_result, id) => qc.removeQueries({ queryKey: qk.goal(id) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: prefix.goals }),
  });
}

/** "Check now": wakes the goal's agent for a check-in outside its schedule; the timeline and plan arrive over the live events. */
export function useCheckGoal() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.goals.check(id),
    onSettled: (_result, _error, id) => void qc.invalidateQueries({ queryKey: qk.goal(id) }),
  });
}
