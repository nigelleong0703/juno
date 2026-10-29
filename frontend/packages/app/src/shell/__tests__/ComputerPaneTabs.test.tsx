import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ComputerPaneSlot } from "../ComputerPaneSlot";

vi.mock("../../components/computer", () => ({
  ComputerPane: ({ headerTabs }: { headerTabs?: ReactNode }) => (
    <div data-testid="computer-pane">{headerTabs}</div>
  ),
  RoutinesPanel: ({ agentId, conversationId }: { agentId: string; conversationId?: string }) => (
    <div data-testid="embedded-routines" data-agent={agentId} data-conversation={conversationId}>
      scoped routines
    </div>
  ),
}));

vi.mock("../../components/chat-files", () => ({
  ConversationFilesPanel: ({ conversationId }: { conversationId: string }) => (
    <div data-testid="embedded-library" data-conversation={conversationId}>
      scoped files
    </div>
  ),
}));

afterEach(cleanup);

function renderSlot(): void {
  render(
    <ThemeProvider defaultTheme="light">
      <TooltipProvider>
        <ComputerPaneSlot agentId="agent-1" conversationId="conv-1" />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

/** The selected tab that is not inside the hidden computer wrapper. */
function visibleSelectedTab(name: string): HTMLElement {
  const tabs = screen.getAllByRole("tab", { name });
  const visible = tabs
    .filter((tab) => tab.getAttribute("aria-selected") === "true")
    .find((tab) => tab.closest(".hidden") === null);
  if (!visible) throw new Error(`no visible selected tab named ${name}`);
  return visible;
}

describe("ComputerPaneSlot tabs", () => {
  it("keeps the computer mounted while files are active", () => {
    renderSlot();
    fireEvent.click(screen.getByRole("tab", { name: "Chat files" }));
    expect(screen.getByTestId("embedded-library")).toBeDefined();
    expect(screen.getByTestId("computer-pane")).toBeDefined();
  });

  it("keeps the computer mounted while routines are active, scoped to the chat", () => {
    renderSlot();
    fireEvent.click(screen.getByRole("tab", { name: "Routines" }));
    const panel = screen.getByTestId("embedded-routines");
    expect(panel).toBeDefined();
    expect(panel.getAttribute("data-agent")).toBe("agent-1");
    expect(panel.getAttribute("data-conversation")).toBe("conv-1");
    expect(screen.getByTestId("computer-pane")).toBeDefined();
  });

  it("moves keyboard focus across all three visible selected tabs", () => {
    renderSlot();
    fireEvent.click(screen.getByRole("tab", { name: "Chat files" }));
    const filesTab = visibleSelectedTab("Chat files");
    filesTab.focus();
    fireEvent.keyDown(filesTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(visibleSelectedTab("Routines"));
    const routinesTab = visibleSelectedTab("Routines");
    fireEvent.keyDown(routinesTab, { key: "ArrowRight" });
    expect(document.activeElement).toBe(visibleSelectedTab("Computer"));
    const computerTab = visibleSelectedTab("Computer");
    fireEvent.keyDown(computerTab, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(visibleSelectedTab("Routines"));
    fireEvent.keyDown(visibleSelectedTab("Routines"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(visibleSelectedTab("Chat files"));
  });
});
