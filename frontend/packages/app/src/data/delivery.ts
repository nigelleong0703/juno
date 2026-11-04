import type { OutboxList } from "@agent-desktop/client";
import { toast } from "@agent-desktop/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { t } from "../lib/i18n";
import { useClient } from "./ClientProvider";
import { qk } from "./keys";

/** Dropped deliveries are looked up newest first; a bubble that is still on screen is almost always on the first page. */
const FIND_PAGES = 3;

/** Whether outgoing messages are paused (the owner's switch, the service's) and which connected apps are failing (`GET /v1/outbox`). */
export function useDeliveryStatus() {
  const client = useClient();
  return useQuery({
    queryKey: qk.delivery(),
    queryFn: async () => {
      const { frozen, health } = await client.outbox.list({ limit: 1 });
      return { frozen, failing: health.failing };
    },
  });
}

type DeliveryStatus = NonNullable<ReturnType<typeof useDeliveryStatus>["data"]>;

/** The owner's "Pause outgoing messages" switch; the row flips at once and goes back if the server refuses. */
export function useSetOutgoingPaused() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (frozen: boolean) => client.outbox.freeze({ frozen }),
    onMutate: async (frozen) => {
      await qc.cancelQueries({ queryKey: qk.delivery() });
      const previous = qc.getQueryData<DeliveryStatus>(qk.delivery());
      if (previous) qc.setQueryData<DeliveryStatus>(qk.delivery(), { ...previous, frozen: { ...previous.frozen, owner: frozen } });
      return { previous };
    },
    onError: (_error, _frozen, context) => {
      if (context?.previous) qc.setQueryData(qk.delivery(), context.previous);
      toast.error(t("delivery.pauseFailed"));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.delivery() }),
  });
}

/** Retry the reply that never reached its platform chat: find its dropped delivery by the item id, send it back to pending. */
export function useRetryDelivery(conversationId: string) {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (itemId: string) => {
      let cursor: string | undefined;
      for (let page = 0; page < FIND_PAGES; page++) {
        const list: OutboxList = await client.outbox.list({ status: "dropped", conversationId, limit: 100, ...(cursor ? { cursor } : {}) });
        const row = list.items.find((entry) => entry.sourceId === itemId);
        if (row) {
          await client.outbox.retry(row.id);
          return;
        }
        if (!list.nextCursor) return;
        cursor = list.nextCursor;
      }
    },
    onError: () => toast.error(t("delivery.retryFailed")),
    // The item's `delivery` flips to pending through the live stream; the refetch covers a missed event.
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.items(conversationId) }),
  });
}
