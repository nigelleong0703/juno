import { useEffect, useRef } from "react";
import { useContext } from "react";
import { ClientContext } from "./ClientProvider";

/** Minimum milliseconds between typing=true posts; a trailing post follows bursts. */
export const TYPING_THROTTLE_MS = 1000;

export interface TypingActivity {
  /** Report user activity; posts typing=true at most once per throttle window. */
  reportTyping: () => void;
  /** The draft stopped (sent, cleared, blurred): post typing=false if active. */
  stopTyping: () => void;
}

/**
 * Boolean typing activity for one existing conversation (GH2 client typing).
 *
 * Only ever sends an activity boolean — draft text never reaches the network.
 * Posts are throttled to one per second with a trailing post after bursts, and
 * a final false fires on stop, blur, unmount, or conversation switch. Failures
 * are swallowed: typing is best-effort presence, never an error surface. The
 * container passes a conversation ID only for existing private threads; new
 * drafts and rooms never ping because they have no ID here.
 */
export function useTypingActivity(conversationId: string | undefined): TypingActivity {
  // Null-safe on purpose: renders without a provider (tests, previews) simply
  // never ping. Production always provides a client through the app shell.
  const bundle = useContext(ClientContext);
  const client = bundle?.client;
  const idRef = useRef(conversationId);
  const activeRef = useRef(false);
  const lastPostRef = useRef(0);
  const trailingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const post = (id: string, active: boolean): void => {
    lastPostRef.current = Date.now();
    activeRef.current = active;
    if (client !== undefined) {
      void client.conversations.typing(id, active).catch(() => undefined);
    }
  };

  // Switching threads (or unmounting) ends activity on the previous one only;
  // no other chat is ever touched.
  useEffect(() => {
    const previous = idRef.current;
    idRef.current = conversationId;
    if (previous !== conversationId && previous !== undefined && activeRef.current) {
      activeRef.current = false;
      if (trailingRef.current !== null) {
        clearTimeout(trailingRef.current);
      trailingRef.current = null;
      }
      if (client !== undefined) {
        void client.conversations.typing(previous, false).catch(() => undefined);
      }
    }
  }, [conversationId, client]);
  useEffect(
    () => () => {
      if (trailingRef.current !== null) {
        clearTimeout(trailingRef.current);
        trailingRef.current = null;
      }
      const id = idRef.current;
      if (id !== undefined && activeRef.current) {
        activeRef.current = false;
        if (client !== undefined) {
          void client.conversations.typing(id, false).catch(() => undefined);
        }
      }
    },
    [client],
  );

  return {
    reportTyping: () => {
      const id = idRef.current;
      if (id === undefined) return;
      const elapsed = Date.now() - lastPostRef.current;
      if (elapsed < TYPING_THROTTLE_MS) {
        if (trailingRef.current === null) {
          trailingRef.current = setTimeout(() => {
            trailingRef.current = null;
            const current = idRef.current;
            if (current !== undefined) post(current, true);
          }, TYPING_THROTTLE_MS - elapsed);
        }
        return;
      }
      if (trailingRef.current !== null) {
        clearTimeout(trailingRef.current);
        trailingRef.current = null;
      }
      post(id, true);
    },
    stopTyping: () => {
      const id = idRef.current;
      if (trailingRef.current !== null) {
        clearTimeout(trailingRef.current);
        trailingRef.current = null;
      }
      if (id === undefined || !activeRef.current) return;
      post(id, false);
    },
  };
}
