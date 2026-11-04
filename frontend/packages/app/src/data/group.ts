import type { GroupSettings, UpdateGroupSettingsInput } from "@agent-desktop/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";

/** The owner's settings for the platform group a conversation belongs to (404 NOT_A_GROUP: the conversation is not one). */
const groupKey = (conversationId: string) => ["group", conversationId] as const;

/** While the first read of earlier messages runs, look again every few seconds. */
const BACKFILL_POLL_MS = 5000;

export function useGroupSettings(conversationId: string | undefined, enabled = true) {
  const client = useClient();
  return useQuery({
    queryKey: groupKey(conversationId ?? ""),
    queryFn: () => client.conversations.groupSettings(conversationId as string),
    enabled: Boolean(conversationId) && enabled,
    retry: false,
    refetchInterval: (query) => (query.state.data?.backfill?.status === "running" ? BACKFILL_POLL_MS : false),
  });
}

/** The cached settings with one change applied; what the screen shows while the save is on its way. */
export function withGroupChange(settings: GroupSettings, input: UpdateGroupSettingsInput): GroupSettings {
  return { ...settings, ...(input.speak === undefined ? {} : { speak: input.speak }), ...(input.delegated === undefined ? {} : { delegated: input.delegated }) };
}

/** Save one change: the screen changes at once, the server's answer replaces it, an error puts the old settings back. */
export function useUpdateGroupSettings(conversationId: string) {
  const client = useClient();
  const qc = useQueryClient();
  const key = groupKey(conversationId);
  return useMutation({
    mutationFn: (input: UpdateGroupSettingsInput) => client.conversations.updateGroupSettings(conversationId, input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: key });
      const before = qc.getQueryData<GroupSettings>(key);
      if (before) qc.setQueryData<GroupSettings>(key, withGroupChange(before, input));
      return { before };
    },
    onError: (_error, _input, context) => {
      if (context?.before) qc.setQueryData(key, context.before);
    },
    onSuccess: (settings) => qc.setQueryData(key, settings),
  });
}
