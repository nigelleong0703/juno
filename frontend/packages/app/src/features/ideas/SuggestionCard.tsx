import { Button, cn } from "@agent-desktop/ui";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { Agent } from "@agent-desktop/client";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { CHARACTER_TINT, agentCharacter } from "../../lib/avatars";

export interface SuggestionCardProps {
  /** Who will do it: their avatar and name lead the card. Without one, `fallbackLeading` stands in. */
  agent?: Agent | undefined;
  fallbackLeading?: ReactNode;
  title: ReactNode;
  reason?: string | undefined;
  /** The one explicit button, bottom right. The card body itself is never tappable (mis-taps). */
  actionLabel?: string | undefined;
  onAction?: (() => void) | undefined;
  /** A compact × in the corner. */
  onDismiss?: (() => void) | undefined;
  dismissLabel?: string;
  className?: string;
  /** Extra rows under the reason (an idea's draft and its buttons). */
  children?: ReactNode;
}

/** The one card language of Ideas and Today's "For you" (iPhone's SuggestionCard): a white card with a thin border, the agent's character on a wash of its tint with its name, the offer, why, then one explicit button. × top right, button bottom right. */
export function SuggestionCard({ agent, fallbackLeading, title, reason, actionLabel, onAction, onDismiss, dismissLabel, className, children }: SuggestionCardProps) {
  return (
    <div className={cn("relative flex flex-col gap-2 rounded-2xl border border-border bg-card p-4", className)}>
      <div className={cn("flex items-center gap-2", onDismiss && "pr-9")}>
        {agent ? (
          <span
            style={{ backgroundColor: `${CHARACTER_TINT[agentCharacter(agent.id, agent.avatar)]}33` }}
            className="flex size-9 shrink-0 items-center justify-center rounded-full"
          >
            <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={30} />
          </span>
        ) : (
          fallbackLeading
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{agent?.name ?? ""}</span>
      </div>
      <p className="line-clamp-3 text-sm text-fg">{title}</p>
      {reason ? <p className="line-clamp-2 text-sm text-muted-foreground">{reason}</p> : null}
      {children}
      {actionLabel && onAction ? (
        <div className="flex justify-end pt-1">
          <Button size="xs" className="rounded-full" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="absolute right-1 top-1 z-10 flex size-9 items-center justify-center rounded-full text-fg-subtle hover:text-fg focus-ring"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
