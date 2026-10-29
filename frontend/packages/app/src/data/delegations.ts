import type { UpdateDelegationInput } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/** What one agent may decide alone (`/v1/delegations`): rules with limits, created from "Allow this kind". */
export function useDelegations(agentId: string) {
  const client = useClient();
  return useQuery({
    queryKey: qk.delegations(agentId),
    queryFn: async () => (await client.delegations.list({ agentId, limit: 100 })).items,
  });
}

export function useUpdateDelegation() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateDelegationInput }) => client.delegations.update(id, patch),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.delegations() }),
  });
}

/** Revoke: the next call of that kind asks again. */
export function useRevokeDelegation() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.delegations.revoke(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.delegations() }),
  });
}
