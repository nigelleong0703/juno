import type { MemoryItemView, MemoryTopicView } from "@agent-desktop/client";
import type { MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeAll } from "vitest";
import { AuthContext } from "../../../auth/AuthContext";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { TeamPage } from "../TeamPage";

/** Shared by the Team page tests: the router and providers around the page, and the memory fixtures. */

export const NOW = "2026-10-20T08:00:00.000Z";

/** Radix and the scroll area measure with ResizeObserver, which jsdom lacks. */
export function stubResizeObserver(): void {
  beforeAll(() => {
    class ResizeObserverStub implements ResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
  });
}

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

export function renderTeam(client: MockClient, start: string, signedInAs?: string) {
  const page = (
    <Routes>
      <Route path="/team/:segment?" element={<><Path /><TeamPage /></>} />
      <Route path="/team/:segment/:id" element={<><Path /><TeamPage /></>} />
      <Route path="*" element={<Path />} />
    </Routes>
  );
  render(
    <MemoryRouter initialEntries={[start]}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} platform={webPlatform} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            {signedInAs ? (
              <AuthContext.Provider value={{ mode: "account", user: { id: "u-1", name: signedInAs, email: "", initials: "NL" }, signOut: () => {} }}>{page}</AuthContext.Provider>
            ) : (
              page
            )}
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

export function memory(patch: Partial<MemoryItemView> = {}): MemoryItemView {
  return {
    id: "m-1",
    text: "Likes oat milk",
    kind: "preference",
    topic: "preferences",
    about: { personId: "p-1", name: "Mina" },
    saidBy: null,
    saidIn: { label: "Your chat" },
    audience: { kind: "owner", label: "Only you" },
    sensitive: false,
    status: "active",
    createdAt: NOW,
    quote: null,
    ...patch,
  };
}

export function topic(patch: Partial<MemoryTopicView> = {}): MemoryTopicView {
  return { topic: "preferences", label: "Preferences", summary: "You like oat milk and early runs.", segments: [], count: 1, updatedAt: NOW, ...patch };
}

/** A client whose memory holds `items` and `topics`; `list` answers like the server (`?topic=` narrows it) and records each call. */
export function withMemory(base: MockClient, items: MemoryItemView[], topics: MemoryTopicView[], calls: string[] = []): MockClient {
  return {
    ...base,
    memoryItems: {
      ...base.memoryItems,
      topics: async () => ({ items: topics }),
      list: async (params) => {
        calls.push(`list:${params?.topic ?? "all"}`);
        return { items: params?.topic ? items.filter((item) => item.topic === params.topic) : items, nextCursor: null };
      },
    },
  };
}
