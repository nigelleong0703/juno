import type { Run, Step } from "@agent-desktop/client";
import { useEffect, useRef } from "react";
import { canStopRun } from "../../data/child-runs";
import { useUiStore } from "../../store/ui";

/** A step on the agent's computer: a computer or browser step, or a computer.* / browser.* tool. */
export const usesComputer = (step: Step): boolean =>
  step.kind === "computer" || step.kind === "browser" || /^(computer|browser)\./.test(step.target);

/**
 * Opens the right-pane workspace on its Computer tab when a live run of this chat first uses the computer.
 * Once per run: the run is marked as handled whether the pane was closed (opened now) or already open, so
 * closing the pane during that run never reopens it. It only changes store state, so focus stays in the composer.
 */
export function useAutoOpenComputer(conversationId: string, runs: Run[] | undefined): void {
  const handled = useRef(new Set<string>());
  useEffect(() => {
    const run = runs?.find((entry) => entry.conversationId === conversationId && canStopRun(entry.status) && !handled.current.has(entry.id) && entry.steps.some(usesComputer));
    if (!run) return;
    handled.current.add(run.id);
    const ui = useUiStore.getState();
    if (ui.computerPanelOpen) return;
    ui.setWorkspaceTab("computer");
    ui.openWorkspace(run.agentId);
  }, [conversationId, runs]);
}
