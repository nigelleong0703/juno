import type { Agent, ApiClient, Conversation } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ClientProvider } from "../../data/ClientProvider";
import { createWebPlatform } from "../../platform";
import { useUiStore } from "../../store/ui";
import { Sidebar } from "../Sidebar";
import { ConversationView } from "../../components/conversation/ConversationView";

afterEach(cleanup);
beforeAll(() => {
  class Observer implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = Observer;
});

const ISO = "2026-10-07T00:00:00Z";

function renderSidebar(client: ApiClient, entry: string): void {
  useUiStore.setState({ sidebarCollapsed: false });
  render(
    <ThemeProvider defaultTheme="light">
      <TooltipProvider>
        <ClientProvider client={client} platform={createWebPlatform()}>
          <MemoryRouter initialEntries={[entry]}>
            <Sidebar />
          </MemoryRouter>
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

function spyClient(): { client: ApiClient; list: ReturnType<typeof vi.fn> } {
  const base = createMockClient({ seed: 1 });
  const list = vi.fn(async () => ({ items: [], nextCursor: null }));
  const client: ApiClient = { ...base, library: { ...base.library, list } };
  return { client, list };
}

async function expectNoGlobalFiles(): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('[data-slot="sidebar-list"]')).not.toBeNull();
  });
  expect(document.querySelector('[data-slot="shared-content"]')).toBeNull();
  expect(document.querySelector('[data-slot="shared-content-recents"]')).toBeNull();
  expect(screen.queryByText("Chat files")).toBeNull();
  expect(screen.queryByText("Select a chat to see its files")).toBeNull();
  expect(screen.queryByText("No files in this chat")).toBeNull();
}

describe("sidebar has no global files UI", () => {
  it("shows no files entry, list, or fetch on a conversation route", async () => {
    const { client, list } = spyClient();
    renderSidebar(client, "/c/conv-a");
    await expectNoGlobalFiles();
    expect(list).not.toHaveBeenCalled();
  });

  it("shows no files entry, list, or fetch without a scope", async () => {
    const { client, list } = spyClient();
    renderSidebar(client, "/new");
    await expectNoGlobalFiles();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("chat header has no files entry", () => {
  const agent: Agent = {
    id: "agent-1",
    name: "Juno",
    handle: "juno",
    avatar: { shape: "circle", color: 1, eyes: "dot" },
    title: "Aide",
    status: "idle",
    section: "Work",
    pinned: false,
    lastActivity: "Said hello",
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
  const conversation: Conversation = {
    id: "conv-1",
    kind: "direct",
    agentIds: ["agent-1"],
    memberIds: ["member-robin"],
    unreadCount: 0,
    lastItemAt: ISO,
    createdAt: ISO,
  };

  it("keeps files out of the chat header", () => {
    render(
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <ConversationView
            conversation={conversation}
            items={[]}
            agents={[agent]}
            primaryAgent={agent}
            isLoading={false}
            isError={false}
            computerPanelOpen={false}
            onRetry={() => {}}
            onSend={() => {}}
            onToggleComputerPanel={() => {}}
            onOpenCitation={() => {}}
          />
        </TooltipProvider>
      </ThemeProvider>,
    );
    expect(screen.queryByRole("button", { name: "Chat files" })).toBeNull();
  });
});
