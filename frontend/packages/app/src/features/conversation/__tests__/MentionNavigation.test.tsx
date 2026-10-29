import type { Conversation } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { useUiStore } from "../../../store/ui";
import { findDirectConversationId } from "../ConversationContainer";
import { ConversationContainer } from "../ConversationContainer";

class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", Observer);

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", Observer);
});

afterEach(() => {
  cleanup();
  useUiStore.getState().clearCompose();
});

function direct(id: string, agentId: string): Conversation {
  return {
    id, kind: "direct", title: "Direct", agentIds: [agentId],
    memberIds: ["user-robin"], unreadCount: 0, lastItemAt: "2026-10-06T00:00:00Z",
    createdAt: "2026-10-06T00:00:00Z",
  };
}
function room(id: string, agentId: string): Conversation {
  return {
    id, kind: "room", title: "Room", agentIds: [agentId],
    memberIds: ["user-robin"], unreadCount: 0, lastItemAt: "2026-10-06T00:00:00Z",
    createdAt: "2026-10-06T00:00:00Z",
  };
}

describe("findDirectConversationId", () => {
  it("finds the direct conversation even when a room containing the agent comes first", () => {
    const list = [room("room-1", "agent-patch"), direct("conv-patch", "agent-patch")];
    expect(findDirectConversationId(list, "agent-patch")).toBe("conv-patch");
  });
  it("returns undefined when only a room contains the agent", () => {
    expect(findDirectConversationId([room("room-1", "agent-patch")], "agent-patch")).toBeUndefined();
  });
  it("returns undefined for unknown agents and unloaded lists", () => {
    expect(findDirectConversationId([direct("conv-patch", "agent-patch")], "agent-gone")).toBeUndefined();
    expect(findDirectConversationId(undefined, "agent-patch")).toBeUndefined();
    expect(findDirectConversationId([], "agent-patch")).toBeUndefined();
  });
});

describe("mention Message without a direct conversation", () => {
  function Path() {
    return <span data-testid="path">{useLocation().pathname}</span>;
  }
  it("replaces a stale draft with only the canonical target and opens compose", async () => {
    const client = createMockClient({ seed: 5 });
    const list = (await client.conversations.list()).items;
    const patchDirect = list.find((c) => c.kind === "direct" && c.agentIds.includes("agent-patch"));
    if (!patchDirect) throw new Error("missing direct");
    const aRoom = list.find((c) => c.kind === "room");
    if (!aRoom) throw new Error("missing room");
    client.conversations.list = async () => ({ items: [], nextCursor: null });
    client.conversations.items = async () => ({
      items: [{
        id: "m", conversationId: aRoom.id, type: "user_message", at: "2026-10-06T00:00:00Z",
        authorId: "user-robin", text: "@patch please review", attachments: [],
        mentions: [{ kind: "agent", id: "agent-patch", label: "@patch" }],
      }],
      nextCursor: null,
    });
    useUiStore.getState().addComposeRecipient({ key: "old", kind: "agent", agentId: "agent-juno", name: "Juno" });
    render(
      <ThemeProvider defaultTheme="dark"><TooltipProvider>
        <ClientProvider client={client} platform={webPlatform}>
          <MemoryRouter initialEntries={["/c/" + aRoom.id]}>
            <Path />
            <ConversationContainer conversationId={aRoom.id} />
          </MemoryRouter>
        </ClientProvider>
      </TooltipProvider></ThemeProvider>,
    );
    await screen.findByRole("button", { name: "Patch" });
    fireEvent.click(screen.getByRole("button", { name: "Patch" }));
    await screen.findByRole("button", { name: "Message" });
    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/new"));
    expect(useUiStore.getState().composeRecipients.map((r) => r.agentId)).toEqual(["agent-patch"]);
    expect(patchDirect.id).toBeTruthy();
  });
});
