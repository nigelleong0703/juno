import type { Agent } from "@agent-desktop/client";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, toast } from "@agent-desktop/ui";
import { MoreHorizontal, Pause, Play, Square } from "lucide-react";
import { useSetAgentPaused, useStopAgent } from "../../../data/mutations";
import { t } from "../../../lib/i18n";

const failed = () => toast.error(t("agentCard.runControl.failed"));

/**
 * The profile's top-bar "…" menu: Pause or Resume (F-09). It follows `pausedAt`, not `status`: a paused agent shows
 * Resume even while it is still finishing work.
 */
export function AgentMenu({ agent }: { agent: Agent }) {
  const setPaused = useSetAgentPaused();
  const paused = agent.pausedAt !== undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={t("agentCard.more")}>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={setPaused.isPending} onSelect={() => setPaused.mutate({ id: agent.id, paused: !paused }, { onError: failed })}>
          {paused ? <Play /> : <Pause />}
          {paused ? t("agentCard.resume") : t("agentCard.pause")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A small Stop beside the doing line while the agent works: stops every active run of it, child runs included (F-09). */
export function StopAgentButton({ agent }: { agent: Agent }) {
  const stop = useStopAgent();
  return (
    <Button variant="secondary" size="xs" className="shrink-0 rounded-full" disabled={stop.isPending} onClick={() => stop.mutate(agent.id, { onError: failed })}>
      <Square className="size-3" />
      {t("agentCard.stop")}
    </Button>
  );
}
