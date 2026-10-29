import type { Agent, Request } from "@agent-desktop/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@agent-desktop/ui";
import { useState } from "react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { requestSentence } from "../../components/request";
import { t } from "../../lib/i18n";
import type { ChatEntry } from "./chatEntries";

/**
 * Sidebar-owned rows share one radius and one avatar size: a single source, no per-row hardcoded
 * values. The radius reads the shared 10px token so it tracks the design system (the row-token
 * stream is adding dedicated `radius-row`/`radius-control` tokens; swap when they land). The
 * shared `Button`/`IconButton` stay pill-shaped and are intentionally not used here: sidebar
 * buttons take the row radius instead. Avatars are 40px circles, matching ChatRow.
 */
export const ROW_RADIUS = "rounded-[var(--radius-md)]";
export const ROW_AVATAR = "size-10";

/**
 * "Needs you (N)": a plain row at the top of the list — a dot and a sentence, no panel — that
 * opens a popover of pending requests across every agent.
 */
export function NeedsYouEntry({
  pending,
  agentById,
  onOpen,
  className,
}: {
  pending: Request[];
  agentById: Map<string, Agent>;
  onOpen: (conversationId: string) => void;
  className?: string;
}) {
  if (pending.length === 0) return null;

  return (
    <div className={cn("px-2 pb-1", className)}>
      <Popover>
        <PopoverTrigger asChild>
          {/* Mirrors the search field's geometry so the two rows read as one column: the count's
              centre sits on the magnifier's centre (12px icon inset + half a 16px icon) and the
              label starts at the same 36px text inset. The icon slot is a full 20px wide so the
              numeric badge (min 20x20, centred text) is never clipped by it. */}
          <button
            type="button"
            aria-label={t("sidebar.needsYouCount", { count: String(pending.length) })}
            className={cn(
              "relative flex w-full items-center py-1 text-left transition-colors hover:bg-sidebar-accent/60 focus-ring",
              ROW_RADIUS,
            )}
          >
            <span className="pointer-events-none absolute left-2.5 top-1/2 flex w-5 -translate-y-1/2 justify-center overflow-visible">
              <span
                data-testid="needs-you-badge"
                className="shell-badge bg-info text-center text-[11px] font-semibold leading-5 text-white"
              >
                {pending.length}
              </span>
            </span>
            <span className="min-w-0 flex-1 truncate pl-9 text-sm text-fg-muted">
              {t("sidebar.needsYou")}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="bottom" className="w-80 p-1">
          <div className="px-2 py-1.5 text-xs text-fg-subtle">{t("sidebar.needsYou")}</div>
          <ul className="flex max-h-80 flex-col overflow-y-auto scrollbar-thin">
            {pending.map((request) => {
              const agent = request.agentId ? agentById.get(request.agentId) : undefined;
              return (
                <li key={request.id}>
                  <button
                    type="button"
                    disabled={!request.conversationId}
                    onClick={() => request.conversationId && onOpen(request.conversationId)}
                    className="flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-bg-subtle focus-ring disabled:opacity-50"
                  >
                    {agent ? (
                      <AgentAvatar
                        agentId={agent.id}
                        avatar={agent.avatar}
                        status={agent.status}
                        size={24}
                        className="mt-0.5"
                      />
                    ) : (
                      <span className="mt-0.5 size-6 shrink-0 rounded-full bg-bg-subtle" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {requestSentence(request)}
                      </span>
                      <span className="block truncate text-xs text-fg-muted">
                        {request.summary}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Rename a direct chat — which, until the client exposes `conversations.update`, renames the agent. */
export function RenameDialog({
  entry,
  pending,
  onClose,
  onSubmit,
}: {
  entry: ChatEntry | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(entry?.name ?? "");

  return (
    <Dialog open={Boolean(entry)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("chatList.renameTitle")}</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          key={entry?.conversation.id ?? "none"}
          defaultValue={entry?.name ?? ""}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSubmit(value.trim() || (entry?.name ?? ""));
          }}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={pending || !value.trim()}
            onClick={() => onSubmit(value.trim())}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
