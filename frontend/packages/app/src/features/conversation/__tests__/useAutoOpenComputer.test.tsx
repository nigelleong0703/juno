import type { Run, Step } from "@agent-desktop/client";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../../../store/ui";
import { useAutoOpenComputer } from "../useAutoOpenComputer";

const step = (target: string, kind: Step["kind"] = "mcp"): Step =>
  ({ id: `s-${target}`, runId: "run-1", index: 0, kind, verb: "Executed", target, status: "running", startedAt: "2026-10-16T09:00:00.000Z", durationMs: 0 });
const run = (id: string, steps: Step[], status: Run["status"] = "running"): Run =>
  ({ id, agentId: "agent-juno", conversationId: "conv-1", status, steps }) as Run;

beforeEach(() => {
  useUiStore.setState({ computerPanelOpen: false, workspaceTab: "files", workspaceAgentId: null });
});

describe("useAutoOpenComputer", () => {
  it("opens the workspace on Computer once per run, and not again after the user closes it", () => {
    const { rerender } = renderHook(({ runs }) => useAutoOpenComputer("conv-1", runs), { initialProps: { runs: [run("run-1", [step("web_search")])] } });
    expect(useUiStore.getState().computerPanelOpen).toBe(false);

    rerender({ runs: [run("run-1", [step("web_search"), step("browser.navigate")])] });
    expect(useUiStore.getState()).toMatchObject({ computerPanelOpen: true, workspaceTab: "computer", workspaceAgentId: "agent-juno" });

    useUiStore.getState().setComputerPanelOpen(false);
    rerender({ runs: [run("run-1", [step("browser.navigate"), step("computer.click")])] });
    expect(useUiStore.getState().computerPanelOpen).toBe(false);

    // The next run is a new decision.
    rerender({ runs: [run("run-2", [step("x", "browser")])] });
    expect(useUiStore.getState().computerPanelOpen).toBe(true);
  });

  it("leaves an already open pane alone, and ignores other chats and finished runs", () => {
    useUiStore.setState({ computerPanelOpen: true, workspaceTab: "files" });
    const { rerender } = renderHook(({ runs }) => useAutoOpenComputer("conv-1", runs), { initialProps: { runs: [run("run-1", [step("computer.click")])] } });
    expect(useUiStore.getState().workspaceTab).toBe("files");

    useUiStore.getState().setComputerPanelOpen(false);
    rerender({ runs: [{ ...run("run-2", [step("computer.click")]), conversationId: "conv-2" }, run("run-3", [step("computer.click")], "completed")] });
    expect(useUiStore.getState().computerPanelOpen).toBe(false);
  });
});
