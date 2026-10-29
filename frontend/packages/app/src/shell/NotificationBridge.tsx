import { toast } from "@agent-desktop/ui";
import { useEffect, useRef } from "react";
import { briefOf } from "../components/request";
import { usePlatform } from "../data/ClientProvider";
import { useResolveRequest } from "../data/mutations";
import { useConversations, usePendingRequests } from "../data/queries";
import { t } from "../lib/i18n";

/**
 * Turns the live request stream into OS-level attention (ARCHITECTURE §3/§9): a toast with an
 * inline Approve action, a native notification, and the dock/taskbar badge. Mounted once at
 * the shell level. The first render only records the current baseline so a reload does not
 * re-announce everything that was already pending.
 */
export function NotificationBridge() {
  const platform = usePlatform();
  const { data: pending } = usePendingRequests();
  const resolve = useResolveRequest();
  const { data: conversations } = useConversations();
  const mutedRef = useRef<Set<string>>(new Set());
  mutedRef.current = new Set((conversations ?? []).filter((c) => c.muted).map((c) => c.id));
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    platform.setBadge(pending?.length ?? 0);
  }, [platform, pending]);

  useEffect(() => {
    if (!pending) return;

    const ids = new Set(pending.map((request) => request.id));

    if (seen.current === null) {
      seen.current = ids;
      return;
    }

    const fresh = pending.filter((request) => !seen.current?.has(request.id));
    seen.current = ids;

    for (const request of fresh) {
      // A muted chat stays quiet: no toast, no native notification (the pending count still shows).
      if (request.conversationId && mutedRef.current.has(request.conversationId)) continue;
      const title =
        request.kind === "question"
          ? t("toast.questionTitle", { name: request.title })
          : request.kind === "signin"
            ? t("toast.signinTitle")
            : t("toast.approvalTitle");

      const body = briefOf(request)?.sentence ?? request.summary;
      platform.notify({ title, body, tag: request.id });

      toast.warning(title, {
        description: body,
        duration: 8000,
        action:
          request.kind === "question"
            ? undefined
            : {
                label: t("request.approve"),
                onClick: () =>
                  resolve.mutate({ id: request.id, decision: { action: "approve", scope: "once" } }),
              },
      });
    }
  }, [pending, platform, resolve]);

  return null;
}
