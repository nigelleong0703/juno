import type { Conversation, ConversationKind } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { TooltipProvider } from "@agent-desktop/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { AgentRedirectPage } from "../AgentRedirectPage";

afterEach(cleanup);

const ISO = "2026-10-07T00:00:00.000Z";
const AGENT = "agent-patch";

function conversation(id: string, kind: ConversationKind, agentIds: string[]): Conversation {
  return {
    id,
    kind,
    agentIds,
    memberIds: ["user-robin"],
    unreadCount: 0,
    lastItemAt: ISO,
    createdAt: ISO,
  };
}

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderPage(list: Conversation[]) {
  const base = createMockClient({ seed: 1 });
  const client = {
    ...base,
    conversations: {
      ...base.conversations,
      list: async () => ({ items: list, nextCursor: null }),
    },
  };
  render(
    <TooltipProvider>
      <ClientProvider client={client} platform={webPlatform}>
        <MemoryRouter initialEntries={[`/agents/${AGENT}`]}>
          <Routes>
            <Route
              path="agents/:agentId"
              element={
                <>
                  <Path />
                  <AgentRedirectPage />
                </>
              }
            />
            <Route path="c/:conversationId" element={<Path />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>
    </TooltipProvider>,
  );
}

describe("agent redirect target", () => {
  it("prefers the sole-agent direct chat over a multi-agent direct, room or peer", async () => {
    renderPage([
      conversation("d-multi", "direct", [AGENT, "agent-juno"]),
      conversation("r-1", "room", [AGENT]),
      conversation("p-1", "peer", [AGENT]),
      conversation("d-sole", "direct", [AGENT]),
    ]);
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/c/d-sole"));
  });

  it("stays put when no sole-agent direct exists", async () => {
    renderPage([
      conversation("d-multi", "direct", [AGENT, "agent-juno"]),
      conversation("r-1", "room", [AGENT]),
      conversation("p-1", "peer", [AGENT]),
    ]);
    // No direct chat: the agent's own page shows, with Start chat, and the URL stays put.
    await waitFor(() => expect(screen.getByRole("button", { name: "Start chat" })).toBeDefined());
    expect(screen.getByTestId("path").textContent).toBe(`/agents/${AGENT}`);
  });
});
