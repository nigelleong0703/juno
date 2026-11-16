import { useCallback, useState } from "react";
import type { LiveScreenTarget } from "../types";

/**
 * The page the voxl iframe shows. An open stream keeps running on its ticket even after the
 * ticket expires, and ticket refreshes arrive as new `target` props every few minutes, so the
 * iframe must NOT follow every new URL (that would reload a healthy stream). It is re-pointed
 * only when the session itself changes (`target.control`: take-over / hand-back, where the server
 * picks the read-write or read-only instance from the ticket) or on an explicit `reload`
 * (Reconnect, load failure), both of which take the freshest ticket.
 */
export function useVoxlSession(target: LiveScreenTarget) {
  const mode = target.control === true;
  const [session, setSession] = useState({ mode, src: target.voxlUrl ?? "", attempt: 0 });
  if (session.mode !== mode) {
    // Derived during render so the old instance never paints under the new mode.
    setSession({ mode, src: target.voxlUrl ?? "", attempt: session.attempt + 1 });
  }
  const reload = useCallback((src: string) => {
    setSession((prev) => ({ ...prev, src, attempt: prev.attempt + 1 }));
  }, []);
  return { src: session.src, attempt: session.attempt, reload };
}
