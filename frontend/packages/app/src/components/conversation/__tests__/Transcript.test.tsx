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

const OLD_AT = "2026-10-05T09:30:00.000Z";

function user(id: string, at: string, text: string): Item {
  return {
    id,
    conversationId: "conv-1",
    at,
    type: "user_message",
    authorId: "member-1",
    text,
    attachments: [],
    mentions: [],
  };
}

function renderTranscript(items: Item[], showAwaiting = false) {
  render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <Transcript items={items} showAwaiting={showAwaiting} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("Transcript entrance", () => {
  it("does not animate loaded history", () => {
    renderTranscript([user("u1", OLD_AT, "Hello"), user("u2", OLD_AT, "Again")]);
    expect(document.querySelector(".transcript-enter")).toBeNull();
    expect(screen.getByText("Hello")).toBeDefined();
  });

  it("floats in items newer than the mount", () => {
    renderTranscript([
      user("u1", OLD_AT, "Hello"),
      user("u2", new Date(Date.now() + 60000).toISOString(), "Fresh"),
    ]);
    const fresh = screen.getByText("Fresh").closest("div.transcript-enter");
    expect(fresh).not.toBeNull();
  });

  it("shows the awaiting bubble only when asked", () => {
    renderTranscript([user("u1", OLD_AT, "Hello")], true);
    expect(document.querySelector("[data-testid=transcript-awaiting]")).not.toBeNull();
    cleanup();
    renderTranscript([user("u1", OLD_AT, "Hello")]);
    expect(document.querySelector("[data-testid=transcript-awaiting]")).toBeNull();
  });
});
