import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStatusPill, EXIT_MS, type AgentStatusPillProps } from "../AgentStatusPill";
import type { AgentStatus } from "../deliveryState";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function pillTree(props: AgentStatusPillProps) {
  return (
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <AgentStatusPill {...props} />
      </TooltipProvider>
    </ThemeProvider>
  );
}

function renderPill(status: AgentStatus | null) {
  const handlers = { onRetry: vi.fn(), onDelete: vi.fn() };
  render(pillTree({ status, ...handlers }));
  return handlers;
}

const pill = () => document.querySelector<HTMLElement>('[data-slot="agent-status-pill"]');

describe("AgentStatusPill", () => {
  it("names a refused send with Retry and Delete that act on its placeholder", () => {
    const handlers = renderPill({ kind: "failed", tempId: "optimistic-1", reason: "Network down" });
    expect(screen.getByText("Not sent")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(handlers.onRetry).toHaveBeenCalledWith("optimistic-1");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(handlers.onDelete).toHaveBeenCalledWith("optimistic-1");
  });

  it("shows reconnecting", () => {
    renderPill({ kind: "reconnecting" });
    expect(screen.getByText("Reconnecting…")).toBeDefined();
  });

  it("is absent when idle, and fades out for EXIT_MS before it unmounts", () => {
    vi.useFakeTimers();
    const { rerender } = render(pillTree({ status: null, onRetry: vi.fn(), onDelete: vi.fn() }));
    expect(pill()).toBeNull();

    rerender(pillTree({ status: { kind: "reconnecting" }, onRetry: vi.fn(), onDelete: vi.fn() }));
    expect(pill()).not.toBeNull();

    rerender(pillTree({ status: null, onRetry: vi.fn(), onDelete: vi.fn() }));
    expect(pill()?.dataset.leaving).toBe("");
    act(() => {
      vi.advanceTimersByTime(EXIT_MS);
    });
    expect(pill()).toBeNull();
  });
});
