import type { Agent, Mention } from "@agent-desktop/client";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentMessageItem, UserMessageItem } from "../../../lib/items";
import { AgentMessage } from "../AgentMessage";
import { Transcript } from "../Transcript";
import { UserMessage } from "../UserMessage";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});
afterEach(cleanup);

const ISO = "2026-10-06T00:00:00.000Z";
const agent: Agent = {
  id: "agent-patch", name: "Engineering Lead", handle: "renamed",
  avatar: { shape: "circle", color: 1, eyes: "dot" }, title: "Aide",
  status: "idle", section: "Work", pinned: false, lastActivity: "", unreadCount: 0,
  model: {
    planner: { provider: "openai", model: "gpt" },
    computer: { provider: "openai", model: "gpt" },
    fast: { provider: "openai", model: "gpt" },
  },
  channels: [], macAccess: false, skillIds: [], pluginIds: [],
  sharing: { publishedToTeam: false }, createdAt: ISO, updatedAt: ISO,
};
const mention: Mention = { kind: "agent", id: agent.id, label: "@patch" };
const lookup = (id: string) => id === agent.id ? agent : undefined;

function message(text: string, mentions: Mention[] = [mention]): UserMessageItem {
  return {
    id: "message-1", conversationId: "conv-1", at: ISO, type: "user_message",
    authorId: "member-1", text, mentions, attachments: [],
  };
}
function show(item: UserMessageItem, agentById = lookup) {
  return render(<UserMessage item={item} agentById={agentById} />);
}

describe("canonical message mention presentation", () => {
  it("replaces the saved token inline with the canonical name and tiny decorative avatar once", () => {
    const item = message("Please ask @PATCH to review.", [mention, { ...mention }]);
    const original = JSON.stringify(item);
    const { container } = show(item);
    const name = screen.getByText(agent.name);
    expect(name.closest("p")?.textContent).toBe("Please ask Engineering Lead to review.");
    expect(screen.getAllByText(agent.name)).toHaveLength(1);
    const recipient = name.closest("[data-agent-id]");
    expect(recipient?.getAttribute("data-agent-id")).toBe(agent.id);
    expect(recipient?.className).toContain("text-inherit");
    expect(recipient?.className).not.toContain("text-bubble-user-foreground");
    expect(recipient?.className).toContain("ring-current");
    expect(recipient?.className).not.toContain("ring-ring");
    expect(recipient?.querySelector("[style]")?.getAttribute("style")).toContain("width: 16px");
    expect(container.textContent).not.toContain("@PATCH");
    expect(container.querySelector('[data-slot="message-recipients"]')).toBeNull();
    expect(JSON.stringify(item)).toBe(original);
  });

  it("shows a deduplicated metadata-only legacy recipient before the body", () => {
    const { container } = show(message("Please review.", [mention, { ...mention }]));
    expect(screen.getAllByText(agent.name)).toHaveLength(1);
    const row = container.querySelector('[data-slot="message-recipients"]');
    expect(row?.textContent).toBe(agent.name);
    expect(row?.nextElementSibling?.textContent).toBe("Please review.");
    expect(container.textContent).not.toContain("@patch");
  });

  it("leaves all unannotated prose untouched even when an agent resolver is available", () => {
    const text = "@patch email me at person@patch.test, then `@patch`.";
    const { container } = show(message(text, []));
    expect(container.querySelector("p")?.textContent).toBe(text);
    expect(screen.queryByText(agent.name)).toBeNull();
  });

  it.each([
    "person@patch.test", "@patch.example", "`@patch`", "``code ` @patch``",
    "```ts\n@patch\n```", "~~~\n@patch\n~~~", "unfinished `@patch", "\\@patch",
    "@patch-other", "https://host/@patch",
  ])("preserves literal text while showing the explicit routed recipient: %s", (text) => {
    const { container } = show(message(text, [mention, { ...mention }]));
    expect(container.querySelector("p")?.textContent).toBe(text);
    expect(screen.getAllByText(agent.name)).toHaveLength(1);
    const row = container.querySelector('[data-slot="message-recipients"]');
    expect(row?.textContent).toBe(agent.name);
    expect(row?.nextElementSibling?.textContent).toBe(text);
  });

  it("keeps code literal while replacing an authorized token outside it", () => {
    const text = "Use `@patch` as an example; ask (@patch).";
    const { container } = show(message(text));
    expect(container.querySelector("p")?.textContent).toBe("Use `@patch` as an example; ask (Engineering Lead).");
    expect(screen.getAllByText(agent.name)).toHaveLength(1);
  });

  it("supports a saved name label without inventing a current-handle match", () => {
    const { container } = show(message("Ask @Engineering Lead; @renamed is plain.", [
      { ...mention, label: "@Engineering Lead" },
    ]));
    expect(container.querySelector("p")?.textContent).toBe("Ask Engineering Lead; @renamed is plain.");
  });

  it("preserves unknown IDs and rejects a resolver returning another agent", () => {
    const item = message("Ask @patch.", [{ ...mention, id: "missing" }]);
    const { container } = show(item, () => agent);
    expect(container.querySelector("p")?.textContent).toBe(item.text);
    expect(screen.queryByText(agent.name)).toBeNull();
    expect(container.querySelector("[data-agent-id]")).toBeNull();
  });

  it("does not choose between distinct IDs with the same serialized label", () => {
    const second = { ...agent, id: "agent-other", name: "Other Lead" };
    const { container } = show(message("Ask @patch.", [mention, { ...mention, id: second.id }]),
      (id) => id === agent.id ? agent : second);
    expect(container.querySelector("p")?.textContent).toBe("Ask @patch.");
    expect(screen.getAllByText(agent.name)).toHaveLength(1);
    expect(screen.getAllByText(second.name)).toHaveLength(1);
    expect(container.querySelector("p [data-agent-id]")).toBeNull();
  });

  it("preserves non-agent labels and attachment names/sizes", () => {
    const item = message("Check #notes and @teammate.", [
      { kind: "file", id: "file-1", label: "#notes" },
      { kind: "user", id: "member-2", label: "@teammate" },
    ]);
    item.attachments = [{ id: "file-1", name: "notes.txt", kind: "file", sizeBytes: 2048 }];
    const { container } = show(item);
    expect(container.querySelector("p")?.textContent).toBe(item.text);
    expect(screen.getByText("notes.txt")).toBeDefined();
    expect(screen.getByText("2.0 KB")).toBeDefined();
    expect(container.querySelector("[data-agent-id]")).toBeNull();
  });

  it("passes the authoritative resolver through Transcript into user messages", () => {
    render(<ThemeProvider defaultTheme="dark"><TooltipProvider>
      <Transcript items={[message("Ask @patch.")]} agentById={lookup} />
    </TooltipProvider></ThemeProvider>);
    expect(screen.getByText(agent.name).closest("p")?.textContent).toBe("Ask Engineering Lead.");
    expect(screen.queryByText("@patch")).toBeNull();
  });
  it("inherits the surrounding bubble foreground in user and agent bubbles (light/dark)", () => {
    for (const theme of ["light", "dark"] as const) {
      const userView = render(<ThemeProvider defaultTheme={theme}><TooltipProvider>
        <UserMessage item={message("Please ask @patch to review.")} agentById={lookup} />
      </TooltipProvider></ThemeProvider>);
      const userTrigger = screen.getByText(agent.name).closest("[data-agent-id]");
      expect(userTrigger?.className).toContain("text-inherit");
      expect(userTrigger?.className).not.toContain("text-bubble-user-foreground");
      expect(userTrigger?.className).toContain("ring-current");
      expect(userTrigger?.className).not.toContain("ring-ring");
      userView.unmount();
      const agentItem: AgentMessageItem = {
        id: "message-2", conversationId: "conv-1", at: ISO, type: "agent_message",
        agentId: "agent-author", markdown: "Ask @renamed to review.", citations: [],
      };
      const agentView = render(<ThemeProvider defaultTheme={theme}><TooltipProvider>
        <AgentMessage item={agentItem} agents={[agent]} />
      </TooltipProvider></ThemeProvider>);
      const agentTrigger = screen.getByText(agent.name).closest("[data-agent-id]");
      expect(agentTrigger?.className).toContain("text-inherit");
      expect(agentTrigger?.className).not.toContain("text-bubble-user-foreground");
      expect(agentTrigger?.className).toContain("ring-current");
      expect(agentTrigger?.className).not.toContain("ring-ring");
      agentView.unmount();
    }
  });
  it("keeps the user recipients row while opening the canonical agent popover", () => {
    const open = vi.fn();
    const { container } = render(<ThemeProvider defaultTheme="light"><TooltipProvider>
      <UserMessage item={message("Please review.", [mention])} agentById={lookup} onOpenAgent={open} />
    </TooltipProvider></ThemeProvider>);
    const row = container.querySelector('[data-slot="message-recipients"]');
    expect(row?.className).toContain("text-bubble-user-foreground");
    fireEvent.click(screen.getByRole("button", { name: agent.name }));
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(agent.id);
  });
});
