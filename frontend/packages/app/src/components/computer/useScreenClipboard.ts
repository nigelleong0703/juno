import { useMemo } from "react";
import { useClient } from "../../data/ClientProvider";
import type { ScreenClipboardBridge } from "./live/screenClipboard";

/** The computer clipboard of one screen (M-CLIP): the two API calls, bound to that screen's id. */
export function useScreenClipboard(screenId: string | undefined): ScreenClipboardBridge | undefined {
  const client = useClient();
  return useMemo(
    () =>
      screenId
        ? {
            copy: () => client.computers.copyScreenClipboard(screenId),
            paste: (input) => client.computers.pasteScreenClipboard(screenId, input),
          }
        : undefined,
    [client, screenId],
  );
}
