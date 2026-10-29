import type { Inspiration, Today } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { isQuietRequest, useConversations, usePendingRequests } from "./queries";
import { qk } from "./keys";

type TodayData = Omit<Today, "now"> & { now?: Today["now"] };

/** What the Today page shows before the summary loads (or if it cannot): nothing needs you, nothing runs, no brief. */
const EMPTY: TodayData = {
  needsYou: { count: 0, top: [], total: 0, items: [] },
  progress: { runsToday: 0, working: [], goals: [] },
  feed: [],
  ideas: [],
  working: [],
  completed: [],
  inspiration: [],
  userState: "regular",
};

/** The Today summary from `GET /v1/today`; `now.hour` is the owner's local hour for the greeting. */
export function useToday(): TodayData {
  const client = useClient();
  const { data } = useQuery({ queryKey: qk.today(), queryFn: () => client.feed.today() });
  const { data: pending } = usePendingRequests();
  const { data: conversations } = useConversations();
  if (!data) return EMPTY;
  // A question or connect card in a direct chat is inline in its chat, not something that needs the owner.
  const quiet = new Set(pending?.filter((request) => isQuietRequest(request, conversations)).map((request) => request.id));
  if (quiet.size === 0) return data;
  const top = data.needsYou.top.filter((entry) => !quiet.has(entry.requestId));
  const dropped = data.needsYou.top.length - top.length;
  return { ...data, needsYou: { ...data.needsYou, count: Math.max(0, data.needsYou.count - dropped), top } };
}

/** "×" on a card: it leaves the list at once and the server keeps it away. */
export function useDismissInspiration() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.inspiration.dismiss(id),
    onMutate: (id) =>
      qc.setQueryData<Today>(qk.today(), (today) => today && { ...today, inspiration: today.inspiration.filter((card: Inspiration) => card.id !== id) }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.today() }),
  });
}

/** Opening a finished run's chat from Today marks it seen, so it leaves the list. */
export function useMarkRunSeen() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => client.runs.markSeen(runId),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.today() }),
  });
}
