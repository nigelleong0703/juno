import type { Agent } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { Check, Plus, Users } from "lucide-react";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { noDragRegion } from "../../lib/drag";
import { t } from "../../lib/i18n";
import { conversationTitle, type Row } from "./composeModel";
import { FIRST_AGENT_COPY } from "./firstAgentCopy";

interface ComposeOptionsCardProps {
  groupMode: boolean;
  rows: Row[];
  safeCursor: number;
  selectedIds: string[];
  agentById: Map<string, Agent>;
  onChoose: (index: number) => void;
  onHover: (index: number) => void;
}

function rowClass(active: boolean) {
  return cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
    active ? "bg-accent text-accent-foreground" : "hover:bg-bg-subtle",
  );
}

/** The open dropdown: create-agent and new-group entries, agents and rooms. */
export function ComposeOptionsCard({
  groupMode,
  rows,
  safeCursor,
  selectedIds,
  agentById,
  onChoose,
  onHover,
}: ComposeOptionsCardProps) {
  return (
    <div style={noDragRegion} className="px-4">
      <div className="mx-auto w-full max-w-[760px]">
        <div
          data-slot="compose-options"
          className="max-h-72 overflow-y-auto scrollbar-thin rounded-xl border border-border bg-popover p-1 shadow-lg"
        >
          {!groupMode && (
            <>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChoose(0)}
                onMouseEnter={() => onHover(0)}
                className={rowClass(safeCursor === 0)}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-fg-muted">
                  <Plus className="size-3.5" />
                </span>
                {t("compose.createNew")}
              </button>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChoose(1)}
                onMouseEnter={() => onHover(1)}
                className={rowClass(safeCursor === 1)}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-fg-muted">
                  <Users className="size-3.5" />
                </span>
                {FIRST_AGENT_COPY.newGroupChat}
              </button>
            </>
          )}
          {rows.map((row, index) => {
            if (row.kind === "create" || row.kind === "group-entry") return null;
            if (row.kind === "group") {
              return (
                <button
                  key={row.key}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onChoose(index)}
                  onMouseEnter={() => onHover(index)}
                  className={rowClass(safeCursor === index)}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-fg-muted">
                    <Users className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg">
                    {conversationTitle(row.conversation, agentById)}
                  </span>
                  <span className="shrink-0 text-xs text-fg-subtle">
                    {row.conversation.agentIds.length}
                  </span>
                </button>
              );
            }
            const selected = selectedIds.includes(row.agent.id);
            return (
              <button
                key={row.key}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onChoose(index)}
                onMouseEnter={() => onHover(index)}
                aria-pressed={groupMode ? selected : undefined}
                className={rowClass(safeCursor === index)}
              >
                <AgentAvatar
                  agentId={row.agent.id}
                  avatar={row.agent.avatar}
                  status={row.agent.status}
                  size={24}
                />
                <span className="min-w-0 flex-1 truncate text-fg">{row.agent.name}</span>
                {groupMode && selected && <Check className="size-4 shrink-0" />}
                {!groupMode && (
                  <span className="shrink-0 text-xs text-fg-subtle">@{row.agent.handle}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
