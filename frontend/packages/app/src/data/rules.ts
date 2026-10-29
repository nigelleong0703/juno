import type { CreateRuleInput, UpdateRuleInput } from "@agent-desktop/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";

/**
 * Auto-review rule mutations (§4.7). Accepting / rejecting agent drafts lives in the shared
 * `data/mutations.ts`; creating, editing and deleting custom rules lives here.
 */
export function useCreateRule() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRuleInput) => client.rules.create(input),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function useUpdateRule() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateRuleInput }) =>
      client.rules.update(id, patch),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function useDeleteRule() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.rules.delete(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}
