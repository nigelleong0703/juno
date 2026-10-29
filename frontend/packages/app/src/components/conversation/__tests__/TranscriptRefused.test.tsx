import type { Item } from "@agent-desktop/client";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Transcript } from "../Transcript";

// jsdom lacks ResizeObserver, which the ui transcript reads on mount.
beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

afterEach(cleanup);

const AT = "2026-10-11T10:00:00.000Z";

function message(id: string, text: string, authorId = "owner"): Item {
  return { id, conversationId: "c1", at: AT, type: "user_message", authorId, text, attachments: [], mentions: [] };
}

function renderWith(items: Item[], extra: Partial<Parameters<typeof Transcript>[0]> = {}) {
  render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <Transcript items={items} {...extra} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("Transcript refused messages", () => {
  it("marks only the refused bubble, never adds a delivery line under any message", () => {
    renderWith(
      [message("optimistic-1", "Lost"), message("m2", "Later")],
      { refused: { "optimistic-1": "Network down" } },
    );
    expect(screen.getAllByRole("img", { name: "Not sent" })).toHaveLength(1);
    expect(document.querySelector('[data-slot="delivery-status"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps the refused mark on a failed message even when later messages follow it", () => {
    renderWith([message("optimistic-1", "Lost"), message("m2", "Later")], {
      refused: { "optimistic-1": "Network down" },
    });
    expect(screen.getByRole("img", { name: "Not sent" })).toBeDefined();
    expect(screen.getByText("Later")).toBeDefined();
  });

  it("shows no reconnecting notice at the bottom of the thread", () => {
    renderWith([message("m1", "Hi")]);
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    expect(document.querySelector('[data-testid="transcript-reconnecting"]')).toBeNull();
  });
});
