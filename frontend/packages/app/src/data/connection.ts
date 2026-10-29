import { useContext, useSyncExternalStore } from "react";
import { ClientContext } from "./ClientProvider";

/**
 * Whether the live event stream is up. Without an event source (mocks, tests, first paint) the
 * answer is "connected", so no reconnecting notice shows for a stream that was never opened.
 */
export function useStreamConnected(): boolean {
  const events = useContext(ClientContext)?.events ?? null;
  return useSyncExternalStore(
    (notify) => events?.subscribeConnection?.(() => notify()) ?? (() => {}),
    () => events?.isConnected?.() ?? true,
  );
}
