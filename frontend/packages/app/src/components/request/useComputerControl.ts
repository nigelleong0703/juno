import type { Request } from "@agent-desktop/client";
import { useAgentComputer } from "../../data/queries";
import { resolveAgentScreen, useAgentScreen, useScreenControl } from "../../data/screens";
import { useUiStore } from "../../store/ui";
import type { ComputerControl } from "./cards";

/**
 * Take-over state for a `computer` request: the agent's screen, who controls it, and the two
 * actions. "Take over" also opens the computer pane, which then shows the live screen in control.
 */
export function useComputerControl(request: Request): ComputerControl | undefined {
  const isComputer = request.kind === "computer";
  const { computer } = useAgentComputer(isComputer ? request.agentId : undefined);
  const { data: fetched } = useAgentScreen(computer?.id, isComputer ? request.agentId : undefined);
  const { takeOver, returnControl } = useScreenControl();
  const setComputerPanelOpen = useUiStore((state) => state.setComputerPanelOpen);
  if (!isComputer) return undefined;
  const screen = fetched ?? resolveAgentScreen(computer, request.agentId);
  return {
    inControl: screen?.controller === "user",
    busy: takeOver.isPending || returnControl.isPending,
    ...(screen ? { screenId: screen.id } : {}),
    onTakeOver: () => {
      if (screen) takeOver.mutate(screen);
      setComputerPanelOpen(true);
    },
    onReturnControl: () => {
      if (screen) returnControl.mutate(screen);
    },
  };
}
