import type { Agent, Mention } from "@agent-desktop/client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserMessageItem } from "../../../lib/items";
import { UserMessage } from "../UserMessage";

afterEach(cleanup);

const ISO = "2026-10-06T00:00:00.000Z";
const agent: Agent = {
  id: "agent-patch", name: "Engineering Lead", handle: "patch",
  avatar: { shape: "circle", color: 1, eyes: "dot" }, title: "Engineering",
  status: "idle", section: "Work", pinned: false, lastActivity: "", unreadCount: 0,
  model: {
    planner: { provider: "openai", model: "gpt" },
    computer: { provider: "openai", model: "gpt" },
    fast: { provider: "openai", model: "gpt" },
  },
  channels: [], macAccess: false, skillIds: [], pluginIds: [],
  sharing: { publishedToTeam: true }, createdAt: ISO, updatedAt: ISO,
};
const mention: Mention = { kind: "agent", id: agent.id, label: "@patch" };
const item: UserMessageItem = {
  id: "item", conversationId: "conv", at: ISO, type: "user_message",
  authorId: "user-robin", text: "Please ask @patch to review.", attachments: [], mentions: [mention],
};
const lookup = (id: string) => (id === agent.id ? agent : undefined);

describe("mention identity card", () => {
  it("opens the card on click and the explicit Message action carries the canonical ID", () => {
    const open = vi.fn();
    render(<UserMessage item={item} agentById={lookup} onOpenAgent={open} />);
    const trigger = screen.getByRole("button", { name: "Engineering Lead" });
    fireEvent.click(trigger);
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.queryByText("@patch")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(agent.id);
  });

  it("closes the card on Escape", async () => {
    const open = vi.fn();
    render(<UserMessage item={item} agentById={lookup} onOpenAgent={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Engineering Lead" }));
    const title = await screen.findByText("Engineering");
    fireEvent.keyDown(title, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByText("Engineering")).toBeNull());
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves raw or unresolved text non-actionable and hides Message without a callback", () => {
    const open = vi.fn();
    const { container } = render(
      <UserMessage item={{ ...item, mentions: [] }} agentById={lookup} onOpenAgent={open} />,
    );
    expect(screen.queryByRole("button", { name: "Engineering Lead" })).toBeNull();
    expect(container.textContent).toContain("@patch");
    expect(open).not.toHaveBeenCalled();
    cleanup();
    const bare = render(<UserMessage item={item} agentById={lookup} />);
    fireEvent.click(screen.getByRole("button", { name: "Engineering Lead" }));
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Message" })).toBeNull();
    expect(bare.container.textContent).not.toContain("patch");
  });
});
