import type { CreateRoutineInput, UpdateRoutineInput } from "@agent-desktop/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";

/**
 * Routine mutations beyond the enable toggle (§4.6): create, edit and delete. The toggle lives
 * in the shared `data/mutations.ts`.
 */
export function useCreateRoutine() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoutineInput) => client.routines.create(input),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["routines"] }),
  });
}

export function useUpdateRoutine() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateRoutineInput }) =>
      client.routines.update(id, patch),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      void qc.invalidateQueries({ queryKey: ["routine"] });
    },
  });
}

export function useDeleteRoutine() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.routines.delete(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["routines"] }),
  });
}

/** Mint or rotate a routine's webhook secret; the answer carries the secret, shown once. */
export function useRotateWebhookSecret() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.routines.rotateWebhook(id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["routines"] });
      void qc.invalidateQueries({ queryKey: ["routine"] });
    },
  });
}
