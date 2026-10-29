import type { UpdateAgentCalendarItem } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/** The agents' own calendar items in `[from, to)`; every agent unless `agentId` is given. */
export function useAgentCalendar(range: { from: Date; to: Date }, agentId?: string) {
  const client = useClient();
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  return useQuery({
    queryKey: qk.calendar(from, to, agentId),
    queryFn: async () => (await client.calendar.list({ from, to, ...(agentId ? { agentId } : {}) })).items,
  });
}

export function useUpdateCalendarItem() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAgentCalendarItem }) => client.calendar.update(id, input),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["calendar"] }),
  });
}

export function useCancelCalendarItem() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.calendar.cancel(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["calendar"] }),
  });
}
