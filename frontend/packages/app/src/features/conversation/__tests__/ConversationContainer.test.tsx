import type { ApiClient, Item, Run, RunsListParams } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { ConversationContainer } from "../ConversationContainer";

// The pane's open/closed state is the only thing the container reads from the UI store; mocking it
// keeps the regression on the container's wiring (`computer.open` sets the panel open, never
// toggles it) and avoids the persisted store's browser-storage dependency under jsdom.
const store = vi.hoisted(() => ({
  setComputerPanelOpen: vi.fn(),
  toggleComputerPanel: vi.fn(),
}));

vi.mock("../../../store/ui", () => ({
  useUiStore: (
    selector: (state: {
      computerPanelOpen: boolean;
      setComputerPanelOpen: (value: boolean) => void;
      toggleComputerPanel: () => void;
      composerPrefill: null;
      setComposerPrefill: () => void;
    }) => unknown,
  ) =>
    selector({
      computerPanelOpen: false,
      setComputerPanelOpen: store.setComputerPanelOpen,
      toggleComputerPanel: store.toggleComputerPanel,
      composerPrefill: null,
      setComposerPrefill: () => {},
    }),
}));

// jsdom lacks ResizeObserver, which the ui transcript reads on mount.
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
  vi.clearAllMocks();
});

// Owner baseline 2026-10-05: the endpoint listed the later question and the long answer before the
// earlier "Hi", and included a system item whose "View computer" button did nothing.
const ITEMS: Item[] = [
  {
    id: "itm-q-late",
    conversationId: "conv-juno",
    at: "2026-10-05T14:54:49.085Z",
    type: "user_message",
    authorId: "member-robin",
    text: "SECOND-QUESTION",
    attachments: [],
    mentions: [],
  },
  {
    id: "itm-a-early",
    conversationId: "conv-juno",
    at: "2026-10-05T14:54:42.846Z",
    type: "agent_message",
    agentId: "agent-juno",
    markdown: "FIRST-REPLY",
    citations: [],
  },
  {
    id: "itm-system",
    conversationId: "conv-juno",
    at: "2026-10-05T14:54:41.000Z",
    type: "system",
    level: "info",
    text: "Computer resumed after being paused while you were away.",
    action: { label: "View computer", command: "computer.open" },
  },
];

function clientReturningItems(items: Item[]): ApiClient {
  const base = createMockClient({ seed: 3 });
  return {
    ...base,
    conversations: {
      ...base.conversations,
      items: async () => ({ items, nextCursor: null }),
    },
  };
}

/** A client whose runs endpoint honours the status filter it is given, like the backend does. */
function clientWithRuns(runs: Run[], listCalls: RunsListParams[], stopped: string[]): ApiClient {
  const base = createMockClient({ seed: 3 });
  return {
    ...base,
    conversations: {
      ...base.conversations,
      items: async () => ({ items: ITEMS, nextCursor: null }),
    },
    runs: {
      ...base.runs,
      list: async (params?: RunsListParams) => {
        listCalls.push(params ?? {});
        const items = runs.filter(
          (run) =>
            (params?.status === undefined || run.status === params.status) &&
            (params?.conversationId === undefined || run.conversationId === params.conversationId),
        );
        return { items, nextCursor: null };
      },
      stop: async (id: string) => {
        stopped.push(id);
        return runs.find((run) => run.id === id) as Run;
      },
    },
  };
}

function renderContainer(client: ApiClient = clientReturningItems(ITEMS)) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider
            client={client}
            platform={webPlatform}
            queryClient={queryClient}
          >
            <ConversationContainer conversationId="conv-juno" />
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("ConversationContainer system actions", () => {
  it("opens the computer pane when the View computer action fires, without toggling", async () => {
    renderContainer();

    fireEvent.click(await screen.findByRole("button", { name: /view computer/i }));

    expect(store.setComputerPanelOpen).toHaveBeenCalledWith(true);
    expect(store.toggleComputerPanel).not.toHaveBeenCalled();
  });

  it("renders the fetched transcript in chronological order", async () => {
    renderContainer();
    await screen.findByText("FIRST-REPLY");

    const transcript = document.querySelector('[data-slot="transcript"]');
    const text = transcript?.textContent ?? "";
    expect(text.indexOf("FIRST-REPLY")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("FIRST-REPLY")).toBeLessThan(text.indexOf("SECOND-QUESTION"));
  });
});

describe("ConversationContainer Stop control (H-94)", () => {
  it("offers Stop for this chat's run waiting for the user and stops that run", async () => {
    const listCalls: RunsListParams[] = [];
    const stopped: string[] = [];
    const waiting: Run = {
      id: "run-wait",
      agentId: "agent-juno",
      conversationId: "conv-juno",
      title: "Needs approval",
      status: "waiting_for_input",
      kind: "chat",
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      startedAt: "2026-10-05T14:54:00.000Z",
      lastActivityAt: "2026-10-05T14:54:00.000Z",
    };
    renderContainer(clientWithRuns([waiting], listCalls, stopped));

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    await waitFor(() => expect(stopped).toEqual(["run-wait"]));
    // The chat reads its runs unfiltered, so a waiting run is in the list the Stop control reads.
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every((params) => params.status === undefined)).toBe(true);
  });
});
