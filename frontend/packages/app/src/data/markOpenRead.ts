import { useEffect, useRef } from "react";
import type { Item } from "@agent-desktop/client";
import { useMarkConversationRead } from "./mutations";

/** Quiet time before marking read, so a reply posted as several bubbles marks once (the iPhone uses the same second). */
export const MARK_READ_DELAY_MS = 1000;

/**
 * The open chat is read as things arrive (F-17): when an item someone else posted lands while the window is
 * visible, one mark-read follows a second of quiet; coming back to a hidden window marks it too. Without this
 * only a sidebar click marked a chat read, so its own unread badge kept counting while the user watched it.
 */
export function useMarkOpenConversationRead(conversationId: string | undefined, items: Item[] | undefined): void {
  const { mutate } = useMarkConversationRead();
  const latestIncoming = (items ?? []).filter((item) => item.type !== "user_message").at(-1)?.id;
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;

  useEffect(() => {
    if (!conversationId) return;
    const mark = () => {
      if (document.visibilityState === "visible") mutateRef.current(conversationId);
    };
    const timer = setTimeout(mark, MARK_READ_DELAY_MS);
    document.addEventListener("visibilitychange", mark);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", mark);
    };
  }, [conversationId, latestIncoming]);
}
