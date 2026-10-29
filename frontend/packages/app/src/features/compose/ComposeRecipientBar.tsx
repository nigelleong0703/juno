import type { Agent } from "@agent-desktop/client";
import { ArrowLeft, X } from "lucide-react";
import type { RefObject } from "react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { t } from "../../lib/i18n";
import { FIRST_AGENT_COPY } from "./firstAgentCopy";

interface ComposeRecipientBarProps {
  groupMode: boolean;
  selectedAgents: Agent[];
  onRemoveMember: (agentId: string) => void;
  onExitGroupMode: () => void;
  query: string;
  onQueryChange: (value: string) => void;
  onFocusInput: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onEscape: () => void;
  onMoveCursor: (direction: 1 | -1) => void;
  onEnter: () => void;
}

/** The titlebar recipient line: member chips, the "To" query field and its keyboard. */
export function ComposeRecipientBar({
  groupMode,
  selectedAgents,
  onRemoveMember,
  onExitGroupMode,
  query,
  onQueryChange,
  onFocusInput,
  inputRef,
  onEscape,
  onMoveCursor,
  onEnter,
}: ComposeRecipientBarProps) {
  return (
    <div data-titlebar className="flex h-[52px] shrink-0 select-none items-center px-4">
      <div className="mx-auto flex w-full max-w-[760px] items-center gap-2">
        {groupMode && (
          <button
            type="button"
            onClick={onExitGroupMode}
            aria-label={FIRST_AGENT_COPY.backToChats}
            className="shrink-0 rounded-full p-1.5 text-fg-subtle transition-colors hover:text-fg focus-ring"
          >
            <ArrowLeft className="size-4" />
          </button>
        )}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          <span className="shrink-0 text-sm text-fg-muted">{t("compose.to")}</span>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {groupMode &&
              selectedAgents.map((agent) => (
                <span
                  key={agent.id}
                  className="inline-flex max-w-48 items-center gap-1.5 rounded-full bg-bg-subtle py-0.5 pl-0.5 pr-1.5 text-sm text-fg"
                >
                  <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={20} />
                  <span className="truncate">{agent.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveMember(agent.id)}
                    aria-label={t("compose.removeRecipient")}
                    className="shrink-0 rounded-full p-0.5 text-fg-subtle transition-colors hover:text-fg focus-ring"
                  >
                    <X className="size-3.5" />
                  </button>
                </span>
              ))}
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              onFocus={onFocusInput}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  onEscape();
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  onMoveCursor(1);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  onMoveCursor(-1);
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  onEnter();
                }
              }}
              placeholder={t("compose.recipientPlaceholder")}
              className="min-w-40 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
              aria-label={t("compose.to")}
            />
          </span>
        </span>
      </div>
    </div>
  );
}
