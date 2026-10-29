import type { Item } from "@agent-desktop/client";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Transcript } from "../Transcript";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

afterEach(cleanup);

const AT = "2026-10-19T10:00:00.000Z";
const origin = { kind: "slack", channelId: "ch1", chatId: "D1", chatType: "private" as const };

const user = (id: string, text: string, extra: Partial<Extract<Item, { type: "user_message" }>> = {}): Item => ({
  id, conversationId: "c1", at: AT, type: "user_message", authorId: "owner", text, attachments: [], mentions: [], ...extra,
});
const agent = (id: string, markdown: string, extra: Partial<Extract<Item, { type: "agent_message" }>> = {}): Item => ({
  id, conversationId: "c1", at: AT, type: "agent_message", agentId: "a1", markdown, citations: [], ...extra,
});

function renderItems(items: Item[]) {
  render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <Transcript items={items} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("Channel markers in the unified conversation", () => {
  it("marks a message that came from a platform and a reply sent to one, and nothing for in-app messages", () => {
    renderItems([user("m1", "from slack", { source: origin }), agent("m2", "answer", { replyTo: origin }), user("m3", "typed here"), agent("m4", "stays here")]);
    expect(screen.getAllByText("via Slack")).toHaveLength(1);
    expect(screen.getAllByText("sent to Slack")).toHaveLength(1);
    expect(document.querySelectorAll('[data-slot="channel-marker"]')).toHaveLength(2);
  });

  it("shows a stranger's name above their bubble, like a group chat", () => {
    renderItems([user("m1", "hello there", { source: origin, channelSender: { kind: "slack", externalId: "U9", name: "Dana", role: "stranger" } })]);
    expect(screen.getByText("Dana")).toBeDefined();
  });
});
