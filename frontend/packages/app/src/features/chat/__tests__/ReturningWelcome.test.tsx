import type { Conversation, ConversationKind } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthContext, type AuthIdentity } from "../../../auth/AuthContext";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { ChatIndexPage } from "../ChatIndexPage";

const GREETING = /^(Good (morning|afternoon|evening)|Still up\?)$/;
const GREETING_ROBIN = /^(Good (morning|afternoon|evening), Robin|Still up, Robin\?)$/;

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

afterEach(() => {
  cleanup();
});

const ISO_NEW = "2026-10-08T00:00:00.000Z";
const ISO_OLD = "2026-10-01T00:00:00.000Z";

const IDENTITY: AuthIdentity = {
  mode: "account",
  user: { id: "user-robin", name: "Robin Lee", email: "robin@example.com", initials: "RL" },
  signOut: () => undefined,
};

function conversation(
  id: string,
  kind: ConversationKind,
  agentIds: string[],
  lastItemAt: string,
  title?: string,
): Conversation {
  return {
    id,
    kind,
    agentIds,
    memberIds: ["user-robin"],
    unreadCount: 0,
    lastItemAt,
    createdAt: lastItemAt,
    ...(title === undefined ? {} : { title }),
  };
}

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderIndex(client: MockClient, identity: AuthIdentity | null) {
  const routes = (
    <MemoryRouter initialEntries={["/"]}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} platform={webPlatform} queryClient={testQueryClient()}>
            <Routes>
              <Route path="/" element={<><Path /><ChatIndexPage view="today" /></>} />
              <Route path="/new" element={<Path />} />
              <Route path="/c/:conversationId" element={<Path />} />
              <Route path="/agents/:agentId" element={<Path />} />
            </Routes>
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
  if (identity === null) return render(routes);
  return render(<AuthContext.Provider value={identity}>{routes}</AuthContext.Provider>);
}

describe("Today landing", () => {
  it("greets by first name on Today when the account has more than one chat", async () => {
    const base = createMockClient({ seed: 201 });
    const ava = await base.agents.create({ name: "Ava" });
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async () => ({
          items: [
            conversation("d-old", "direct", [ava.id], ISO_OLD),
            conversation("d-new", "direct", [ava.id], ISO_NEW),
          ],
          nextCursor: null,
        }),
      },
    };
    renderIndex(client, IDENTITY);
    await screen.findByRole("heading", { name: GREETING_ROBIN });
    expect(screen.getByTestId("path").textContent).toBe("/");
  });

  it("retries a later-page failure into the greeting, after reading every page", async () => {
    const base = createMockClient({ seed: 207 });
    const ava = await base.agents.create({ name: "Ava" });
    let secondPageCalls = 0;
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async (params) => {
          if (params?.cursor !== undefined && params?.cursor !== null) {
            secondPageCalls += 1;
            if (secondPageCalls === 1) throw new Error("page2 failed");
            return {
              items: [conversation("d-page2", "direct", [ava.id], ISO_NEW)],
              nextCursor: null,
            };
          }
          return {
            items: [conversation("d-old", "direct", [ava.id], ISO_OLD)],
            nextCursor: "page2",
          };
        },
      },
    };
    renderIndex(client, IDENTITY);
    await screen.findByRole("alert");
    expect(screen.getByTestId("path").textContent).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: GREETING_ROBIN });
    expect(secondPageCalls).toBe(2);
  });

  it("greets without a name when no identity is present", async () => {
    const base = createMockClient({ seed: 208 });
    const ava = await base.agents.create({ name: "Ava" });
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async () => ({
          items: [conversation("d-new", "direct", [ava.id], ISO_NEW)],
          nextCursor: null,
        }),
      },
    };
    renderIndex(client, null);
    await screen.findByRole("heading", { name: GREETING });
    expect(screen.queryByText(/Robin/)).toBeNull();
    expect(screen.queryByText(/Unknown/)).toBeNull();
  });

  it("never greets a legacy token session by name", async () => {
    const base = createMockClient({ seed: 209 });
    const ava = await base.agents.create({ name: "Ava" });
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async () => ({
          items: [conversation("d-new", "direct", [ava.id], ISO_NEW)],
          nextCursor: null,
        }),
      },
    };
    renderIndex(client, {
      mode: "token",
      user: { id: "token-session", name: "Token session", email: "", initials: "T" },
    });
    await screen.findByRole("heading", { name: GREETING });
    expect(screen.queryByText(/Token session/)).toBeNull();
  });
});
