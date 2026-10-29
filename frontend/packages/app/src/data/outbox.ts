import type { AdmissionIdentity, ComposerPayload, Item } from "@agent-desktop/client";
import { create } from "zustand";
import { t } from "../lib/i18n";
import { mergeItemChronologically } from "./events";

/**
 * A message the server refused. Its optimistic placeholder stays in the transcript (kept in this
 * store, so a refetch cannot drop it) and the owner can Retry (resend the same payload) or Delete it.
 * Keyed by the placeholder's id.
 */
export interface FailedSend {
  tempId: string;
  identity: AdmissionIdentity;
  conversationId: string;
  payload: ComposerPayload;
  reason: string;
  item: Item;
}

interface OutboxState {
  failed: Record<string, FailedSend>;
  markFailed(entry: FailedSend): void;
  forget(tempId: string): void;
}

export const useOutbox = create<OutboxState>()((set) => ({
  failed: {},
  markFailed: (entry) => set((state) => ({ failed: { ...state.failed, [entry.tempId]: entry } })),
  forget: (tempId) =>
    set((state) => {
      if (!(tempId in state.failed)) return state;
      const { [tempId]: _removed, ...rest } = state.failed;
      return { failed: rest };
    }),
}));

/** Short owner-facing reason for a refused send: network, server message, or unknown. */
export function sendFailureReason(error: unknown): string {
  // A fetch that never reached the server rejects with a TypeError.
  if (error instanceof TypeError) return t("delivery.reason.network");
  if (error instanceof Error && error.message && !/^HTTP \d+$/.test(error.message)) return error.message;
  if (error instanceof Error && "status" in error) return t("delivery.reason.server");
  return t("delivery.unknownReason");
}

/**
 * The conversation's items with its refused placeholders put back in chronological order. A refetch
 * or another send's invalidation returns the server list without them; this keeps them visible.
 */
export function withRefused(
  items: readonly Item[],
  failed: Readonly<Record<string, FailedSend>>,
  conversationId: string | undefined,
): Item[] {
  let merged = [...items];
  for (const entry of Object.values(failed)) {
    if (entry.conversationId !== conversationId || merged.some((item) => item.id === entry.tempId)) continue;
    merged = mergeItemChronologically(merged, entry.item);
  }
  return merged;
}
