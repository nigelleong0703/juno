import type { Conversation, ConversationKind } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { useUiStore } from "../../../store/ui";
import { ChatIndexPage } from "../ChatIndexPage";
import { ComposeConversation } from "../../compose/ComposeConversation";
import { FIRST_AGENT_COPY } from "../../compose/firstAgentCopy";

const GREETING = /^(Good (morning|afternoon|evening)|Still up)/;

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
  useUiStore.setState({ composeRecipients: [] });
});

const ISO_NEW = "2026-10-08T00:00:00.000Z";
const ISO_MID = "2026-10-05T00:00:00.000Z";
const ISO_OLD = "2026-10-01T00:00:00.000Z";

function conversation(
  id: string,
  kind: ConversationKind,
  agentIds: string[],
  lastItemAt: string,
): Conversation {
  return {
    id,
    kind,
    agentIds,
    memberIds: ["user-robin"],
    unreadCount: 0,
    lastItemAt,
    createdAt: lastItemAt,
  };
}

function Path() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function Opened() {
  const { id } = useParams();
  return <div data-testid="opened">{id}</div>;
}

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderIndex(client: MockClient) {
  return render(
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
    </MemoryRouter>,
  );
}

function renderCompose(client: MockClient) {
  return render(
    <MemoryRouter initialEntries={["/new"]}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} platform={webPlatform} queryClient={testQueryClient()}>
            <Routes>
              <Route path="/new" element={<ComposeConversation />} />
              <Route path="/c/:id" element={<Opened />} />
            </Routes>
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function emptyListsClient(base: MockClient): MockClient {
  return {
    ...base,
    agents: {
      ...base.agents,
      list: async () => ({ items: [], nextCursor: null }),
    },
    conversations: {
      ...base.conversations,
      list: async () => ({ items: [], nextCursor: null }),
    },
  };
}

/**
 * UI102 shows the animated platform intro before the naming form. The skip
 * control is optional: older revisions render the form immediately, so this
 * waits for either surface, clicks the exact skip label only when present,
 * and leaves the caller to assert the naming form.
 */
async function dismissIntroIfPresent(): Promise<void> {
  await waitFor(() => {
    const form = screen.queryByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel);
    const skip = screen.queryByRole("button", { name: FIRST_AGENT_COPY.introSkip });
    if (form === null && skip === null) throw new Error("waiting for intro or name form");
  });
  const skip = screen.queryByRole("button", { name: FIRST_AGENT_COPY.introSkip });
  if (skip) fireEvent.click(skip);
}

describe("ChatIndexPage account entry", () => {
  it("opens the home for an account with own chats, not a redirect", async () => {
    const base = createMockClient({ seed: 101 });
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async () => ({
          items: [
            conversation("d-old", "direct", ["agent-juno"], ISO_OLD),
            conversation("d-new", "direct", ["agent-patch"], ISO_NEW),
          ],
          nextCursor: null,
        }),
      },
    };
    renderIndex(client);
    await screen.findByRole("heading", { name: GREETING });
    expect(screen.getByTestId("path").textContent).toBe("/");
  });

  it("task and peer threads alone are not own chats, so an agentless account goes to /new", async () => {
    const base = createMockClient({ seed: 102 });
    const client: MockClient = {
      ...base,
      agents: { ...base.agents, list: async () => ({ items: [], nextCursor: null }) },
      conversations: {
        ...base.conversations,
        list: async () => ({
          items: [
            conversation("t-new", "task", ["agent-juno"], ISO_NEW),
            conversation("p-new", "peer", ["agent-juno", "agent-patch"], ISO_NEW),
          ],
          nextCursor: null,
        }),
      },
    };
    renderIndex(client);
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/new"));
  });

  it("reads a second cursor page before deciding an agentless account has no chats", async () => {
    const base = createMockClient({ seed: 103 });
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async (params) => {
          if (params?.cursor !== undefined && params?.cursor !== null) {
            return {
              items: [conversation("d-page2", "direct", ["agent-patch"], ISO_NEW)],
              nextCursor: null,
            };
          }
          return {
            items: [
              conversation("t-1", "task", ["agent-juno"], ISO_MID),
            ],
            nextCursor: "page2",
          };
        },
      },
    };
    // Agents are absent here, so only the chat found on page two can keep the account off /new.
    renderIndex({ ...client, agents: { ...base.agents, list: async () => ({ items: [], nextCursor: null }) } });
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/"));
    // No agent yet, so Today welcomes the user to the first one.
    await screen.findByRole("heading", { name: /^Welcome/ });
    expect(screen.getByTestId("path").textContent).toBe("/");
  });

  it("a later-page failure offers retry and never declares a prefix latest", async () => {
    const base = createMockClient({ seed: 104 });
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
              items: [conversation("d-page2", "direct", ["agent-patch"], ISO_NEW)],
              nextCursor: null,
            };
          }
          return {
            items: [conversation("d-old", "direct", ["agent-juno"], ISO_OLD)],
            nextCursor: "page2",
          };
        },
      },
    };
    renderIndex(client);
    await screen.findByRole("alert");
    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(screen.queryByText(FIRST_AGENT_COPY.firstAgentCreate)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: GREETING });
    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(secondPageCalls).toBe(2);
  });

  it("rejects a non-advancing cursor instead of paging forever", async () => {
    const base = createMockClient({ seed: 115 });
    let calls = 0;
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async () => {
          calls += 1;
          return {
            items: [conversation("d-old", "direct", ["agent-juno"], ISO_OLD)],
            nextCursor: "stuck",
          };
        },
      },
    };
    renderIndex(client);
    await screen.findByRole("alert");
    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(screen.queryByText(FIRST_AGENT_COPY.firstAgentCreate)).toBeNull();
    expect(calls).toBe(2);
  });

  it("hands a fully empty account off to /new", async () => {
    renderIndex(emptyListsClient(createMockClient({ seed: 105 })));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/new"));
  });

  it("keeps an agent-only account on Today, without the first-agent card, instead of /new", async () => {
    const base = createMockClient({ seed: 106 });
    const agentsExist: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async () => ({ items: [], nextCursor: null }),
      },
    };
    renderIndex(agentsExist);
    await screen.findByRole("heading", { name: GREETING });
    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(screen.queryByRole("link", { name: "Meet your first agent" })).toBeNull();
  });

  it("a load failure offers retry only, never creation", async () => {
    const base = createMockClient({ seed: 107 });
    let calls = 0;
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async () => {
          calls += 1;
          if (calls === 1) throw new Error("entry failed");
          return { items: [], nextCursor: null };
        },
      },
    };
    renderIndex(client);
    await screen.findByRole("alert");
    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(screen.queryByText(FIRST_AGENT_COPY.firstAgentCreate)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: GREETING });
    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("keeps no onboarding completion flag in localStorage", async () => {
    const storage = window.localStorage;
    storage?.clear();
    const client = emptyListsClient(createMockClient({ seed: 108 }));
    const view = renderIndex(client);
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/new"));
    view.unmount();
    renderCompose(client);
    await dismissIntroIfPresent();
    await screen.findByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel);
    const flagged = storage
      ? Object.keys(storage).filter((key) => /onboard|tour|first-agent|firstAgent/i.test(key))
      : [];
    expect(flagged).toEqual([]);
  });
});

describe("ComposeConversation first-agent onboarding", () => {
  it("shows the compact onboarding and hides composer and recipient controls", async () => {
    const client = emptyListsClient(createMockClient({ seed: 109 }));
    const view = renderCompose(client);
    await dismissIntroIfPresent();
    await screen.findByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel);
    expect(screen.getByText(FIRST_AGENT_COPY.firstAgentTitle)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: FIRST_AGENT_COPY.firstAgentCreate }),
    ).toBeTruthy();
    const slot = view.container.querySelector('[data-slot="first-agent-onboarding"]');
    expect(slot).not.toBeNull();
    const mascot = slot?.querySelector("img");
    expect(mascot?.getAttribute("height")).toBe("56");
    expect(screen.queryByRole("textbox", { name: /^Message/ })).toBeNull();
    expect(screen.queryByPlaceholderText("Search or create agents")).toBeNull();
  });

  it("waits for a deferred conversations read before offering first creation", async () => {
    const base = createMockClient({ seed: 116 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client: MockClient = {
      ...base,
      agents: {
        ...base.agents,
        list: async () => ({ items: [], nextCursor: null }),
      },
      conversations: {
        ...base.conversations,
        list: async () => {
          await gate;
          return { items: [], nextCursor: null };
        },
      },
    };
    renderCompose(client);
    await screen.findByText("Loading…");
    expect(screen.queryByText(FIRST_AGENT_COPY.firstAgentCreate)).toBeNull();
    release();
    await dismissIntroIfPresent();
    await screen.findByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel);
    expect(
      screen.getByRole("button", { name: FIRST_AGENT_COPY.firstAgentCreate }),
    ).toBeTruthy();
  });

  it("shows the normal compose route when agents exist", async () => {
    const base = createMockClient({ seed: 110 });
    await base.agents.create({ name: "Ava" });
    renderCompose(base);
    await screen.findByText("Ava");
    expect(screen.getByRole("textbox", { name: /^Message/ })).toBeTruthy();
    expect(
      document.querySelector('[data-slot="first-agent-onboarding"]'),
    ).toBeNull();
  });

  it("an agents failure never enables first creation", async () => {
    const base = createMockClient({ seed: 111 });
    const client: MockClient = {
      ...base,
      agents: {
        ...base.agents,
        list: async () => {
          throw new Error("agents failed");
        },
      },
    };
    renderCompose(client);
    await screen.findByRole("alert");
    expect(screen.queryByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel)).toBeNull();
    expect(screen.queryByText(FIRST_AGENT_COPY.firstAgentCreate)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("an agentless conversations failure never enables first creation", async () => {
    const base = createMockClient({ seed: 112 });
    const client: MockClient = {
      ...base,
      agents: {
        ...base.agents,
        list: async () => ({ items: [], nextCursor: null }),
      },
      conversations: {
        ...base.conversations,
        list: async () => {
          throw new Error("conversations failed");
        },
      },
    };
    renderCompose(client);
    await screen.findByRole("alert");
    expect(screen.queryByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel)).toBeNull();
    expect(screen.queryByText(FIRST_AGENT_COPY.firstAgentCreate)).toBeNull();
  });

  it("a real first create retries the same thread after partial success", async () => {
    const base = createMockClient({ seed: 113 });
    const agentCalls: unknown[] = [];
    const requestIds: Array<string | undefined> = [];
    let convCalls = 0;
    const client: MockClient = {
      ...emptyListsClient(base),
      agents: {
        ...base.agents,
        list: async () => ({ items: [], nextCursor: null }),
        create: async (input) => {
          agentCalls.push(input);
          return base.agents.create(input);
        },
      },
      conversations: {
        ...base.conversations,
        list: async () => ({ items: [], nextCursor: null }),
        create: async (input) => {
          convCalls += 1;
          requestIds.push(input.requestId);
          if (convCalls === 1) throw new Error("conversation failed");
          return base.conversations.create(input);
        },
      },
    };
    renderCompose(client);
    await dismissIntroIfPresent();
    const nameBox = await screen.findByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel);
    fireEvent.change(nameBox, { target: { value: "Juno" } });
    fireEvent.click(screen.getByRole("button", { name: FIRST_AGENT_COPY.firstAgentCreate }));
    await screen.findByRole("alert");
    expect(agentCalls).toHaveLength(1);
    expect(convCalls).toBe(1);
    expect((nameBox as HTMLInputElement).value).toBe("Juno");
    fireEvent.click(screen.getByRole("button", { name: FIRST_AGENT_COPY.firstAgentCreate }));
    await screen.findByTestId("opened");
    expect(agentCalls).toHaveLength(1);
    expect(convCalls).toBe(2);
    expect(requestIds[0]).toBeDefined();
    expect(requestIds[0]).toBe(requestIds[1]);
  });

  it("an empty name explains instead of creating", async () => {
    const base = createMockClient({ seed: 114 });
    let agentCalls = 0;
    const client: MockClient = {
      ...emptyListsClient(base),
      agents: {
        ...base.agents,
        list: async () => ({ items: [], nextCursor: null }),
        create: async (input) => {
          agentCalls += 1;
          return base.agents.create(input);
        },
      },
    };
    renderCompose(client);
    await dismissIntroIfPresent();
    await screen.findByLabelText(FIRST_AGENT_COPY.firstAgentNameLabel);
    fireEvent.click(screen.getByRole("button", { name: FIRST_AGENT_COPY.firstAgentCreate }));
    await screen.findByText(FIRST_AGENT_COPY.firstAgentNameRequired);
    expect(agentCalls).toBe(0);
  });
});
