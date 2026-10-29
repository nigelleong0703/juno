import { cn } from "@agent-desktop/ui";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The agent bubble every header shares (the chat's identity capsule, and the agent scope on Ideas, Feed, Goals,
 * Automations and Library): a round translucent disc holding the avatar(s), the name capsule under it with a
 * chevron, and an optional line below the name (presence). One component so the two never drift apart.
 */
export function AgentBubble({ media, name, below, heading = false }: { media: ReactNode; name: ReactNode; below?: ReactNode; /** The name is the page's h1 (the chat). */ heading?: boolean }) {
  return (
    <>
      <span className="grid size-[72px] place-items-center rounded-full bg-muted/70 backdrop-blur-md">{media}</span>
      <span className="flex max-w-56 flex-col items-center rounded-full border border-border bg-muted/70 px-3 py-0.5 leading-tight text-fg backdrop-blur-md">
        <span className="flex max-w-full items-center gap-1 text-sm font-medium leading-tight">
          <span {...(heading ? { role: "heading", "aria-level": 1 } : {})} className={cn("min-w-0 truncate")}>{name}</span>
          <ChevronDown className="size-3 shrink-0 text-fg-muted" />
        </span>
        {below}
      </span>
    </>
  );
}
