import type { Agent } from "@agent-desktop/client";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentMessageItem } from "../../../lib/items";
import { AgentMessage } from "../AgentMessage";
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

const ISO = "2026-10-07T00:00:00.000Z";

function agent(input: { id: string; name: string; handle: string; title?: string }): Agent {
  return {
    id: input.id,
    name: input.name,
    handle: input.handle,
    avatar: { shape: "circle", color: 1, eyes: "dot" },
    title: input.title ?? "Aide",
    status: "idle",
    section: "Work",
    pinned: false,
    lastActivity: "",
    unreadCount: 0,
    model: {
      planner: { provider: "openai", model: "gpt" },
      computer: { provider: "openai", model: "gpt" },
      fast: { provider: "openai", model: "gpt" },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: ISO,
    updatedAt: ISO,
  };
}

const nova = agent({ id: "agent-nova", name: "Nova", handle: "newagent" });

function message(markdown: string, agentId = nova.id): AgentMessageItem {
  return {
    id: "m1",
    conversationId: "conv-1",
    at: ISO,
    type: "agent_message",
    agentId,
    markdown,
    citations: [],
  };
}

function renderMessage(markdown: string, agents: Agent[], onOpenAgent?: (id: string) => void) {
  return render(
    <ThemeProvider defaultTheme="light">
      <TooltipProvider>
        <AgentMessage item={message(markdown)} agents={agents} onOpenAgent={onOpenAgent} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe("agent prose mentions", () => {
  it("renders a known unique handle as the canonical name with a tiny avatar", () => {
    const { container } = renderMessage("Ask @newagent to review.", [nova]);
    const name = screen.getByText("Nova");
    expect(name.closest("p")?.textContent).toBe("Ask Nova to review.");
    const trigger = name.closest("button");
    expect(trigger).not.toBeNull();
    expect((trigger?.querySelector("img")?.parentElement as HTMLElement | null)?.style.width).toBe("16px");
    expect(container.textContent).not.toContain("@newagent");
  });

  it("opens the canonical agent through the identity popover action", () => {
    const open = vi.fn();
    renderMessage("Ping @newagent.", [nova], open);
    fireEvent.click(screen.getByRole("button", { name: "Nova" }));
    expect(screen.getByText("Aide")).toBeDefined();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(nova.id);
  });

  it("leaves unknown handles, email, code and links literal", async () => {
    const markdown =
      "Mail hello@newagent.com, ask @ghost, use `@newagent`, then [Nova](https://x/@newagent).";
    const { container } = renderMessage(markdown, [nova]);
    expect(container.textContent).toContain("hello@newagent.com");
    expect(container.textContent).toContain("@ghost");
    expect(container.querySelector("code")?.textContent).toBe("@newagent");
    // No token in this line resolves to a mention.
    expect(container.querySelector("[data-agent-id]")).toBeNull();
    // The Markdown link stays a link: its label is untouched and its URL is still reachable.
    fireEvent.click(screen.getByRole("button", { name: "Nova" }));
    await screen.findByText("https://x/@newagent");
  });

  it("refuses ambiguous handles shared by two agents", () => {
    const twin = agent({ id: "agent-twin", name: "Nova Twin", handle: "newagent" });
    const { container } = renderMessage("Ask @newagent.", [nova, twin]);
    expect(container.textContent).toContain("@newagent");
    expect(screen.queryByRole("button", { name: "Nova" })).toBeNull();
  });

  it("keeps GFM tables and resolves mentions inside them", () => {
    const markdown = "| Agent | Status |\n| --- | --- |\n| @newagent | Ready |";
    const { container } = renderMessage(markdown, [nova]);
    expect(container.querySelector("table")).not.toBeNull();
    expect(screen.getByText("Nova").closest("td")?.textContent).toBe("Nova");
  });

  it("presents mentions once the roster loads and renames", () => {
    const view = render(
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <AgentMessage item={message("Ask @newagent.")} agents={[]} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    expect(view.container.textContent).toContain("@newagent");
    view.rerender(
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <AgentMessage item={message("Ask @newagent.")} agents={[nova]} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText("Nova")).toBeDefined();
    const renamed = agent({ id: nova.id, name: "Nova Renamed", handle: "newagent" });
    view.rerender(
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <AgentMessage item={message("Ask @newagent.")} agents={[renamed]} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    expect(screen.getByText("Nova Renamed")).toBeDefined();
  });

  it("flows the roster through the transcript", async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Transcript items={[message("Ask @newagent.")]} agents={[nova]} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByText("Nova")).toBeDefined());
  });
});
