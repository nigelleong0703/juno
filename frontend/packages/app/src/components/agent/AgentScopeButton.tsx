import type { Agent } from "@agent-desktop/client";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@agent-desktop/ui";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import { noDragRegion } from "../../lib/drag";
import { t } from "../../lib/i18n";
import { AgentAvatar } from "./AgentAvatar";
import { AgentBubble } from "./AgentBubble";

/** Rows shown before the list scrolls. */
const SCOPE_ROWS_HEIGHT = "max-h-80";

/** The capsule every scope control wears. */
export const SCOPE_TRIGGER = "flex h-9 items-center gap-2 rounded-full bg-muted text-[13px] font-semibold text-fg transition-colors hover:bg-interactive-hover focus-ring";

/**
 * The "all agents / one agent" scope as a capsule (iPhone's AgentScopeButton). "all" means no filter.
 * With `all={false}` it is a plain picker of one agent: no "all" row, named by `label`.
 */
export function AgentScopeButton({
  agents,
  value,
  onChange,
  all = true,
  label = t("feed.allAgents"),
  bubble = false,
}: {
  agents: Agent[] | undefined;
  value: string;
  onChange: (agentId: string) => void;
  all?: boolean;
  label?: string;
  /** The chat header's look: a round avatar with the name capsule under it (page headers). */
  bubble?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const list = agents ?? [];
  const chosen = list.find((agent) => agent.id === value);
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {bubble ? (
          <button type="button" aria-label={label} style={noDragRegion} className="flex min-w-0 flex-col items-center gap-0.5 px-2 focus-ring">
            <AgentBubble
              media={chosen ? <AgentAvatar agentId={chosen.id} avatar={chosen.avatar} status={chosen.status} size={60} /> : list.length ? <AvatarStack agents={list} size={36} max={2} /> : null}
              name={chosen?.name ?? label}
            />
          </button>
        ) : (
        <button type="button" aria-label={label} className={cn(SCOPE_TRIGGER, "pl-1.5 pr-3")}>
          {chosen ? <AgentAvatar agentId={chosen.id} avatar={chosen.avatar} size={24} /> : list.length ? <AvatarStack agents={list} size={24} /> : null}
          <span className="max-w-32 truncate">{chosen?.name ?? label}</span>
          <ChevronDown className="size-3.5 text-fg-muted" />
        </button>
        )}
      </PopoverTrigger>
      <PopoverContent align={bubble ? "center" : "end"} className="w-64 p-1.5">
        <ul className={cn("flex flex-col overflow-y-auto", SCOPE_ROWS_HEIGHT)}>
          {all ? (
            <ScopeRow label={t("feed.allAgents")} selected={value === "all"} onPick={() => pick("all")}>
              <AvatarStack agents={list} size={20} max={2} />
            </ScopeRow>
          ) : null}
          {list.map((agent) => (
            <ScopeRow key={agent.id} label={agent.name} selected={value === agent.id} onPick={() => pick(agent.id)}>
              <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={28} />
            </ScopeRow>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export function ScopeRow({ label, selected, onPick, children }: { label: string; selected: boolean; onPick: () => void; children?: React.ReactNode }) {
  return (
    <li>
      <button type="button" onClick={onPick} className="flex h-11 w-full items-center gap-3 rounded-[10px] px-2 text-left text-sm text-fg hover:bg-interactive-hover focus-ring">
        {children ? <span className="flex w-7 shrink-0 justify-center">{children}</span> : null}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {selected ? <Check className="size-4 text-fg-muted" /> : null}
      </button>
    </li>
  );
}

/** Up to `max` avatars overlapping, each cut out with a ring in the pill's own surface colour. */
function AvatarStack({ agents, size, max = 3 }: { agents: Agent[]; size: number; max?: number }) {
  return (
    <span className="flex -space-x-2">
      {agents.slice(0, max).map((agent) => (
        <span key={agent.id} className="flex rounded-full ring-2 ring-muted">
          <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={size} />
        </span>
      ))}
    </span>
  );
}
