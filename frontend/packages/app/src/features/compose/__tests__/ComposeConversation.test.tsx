import type { CreateConversationInput } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { useUiStore } from "../../../store/ui";
import { ComposeConversation } from "../ComposeConversation";
import { FIRST_AGENT_COPY } from "../firstAgentCopy";

type CapturedBody = CreateConversationInput;

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
  useUiStore.setState({ composeRecipients: [] });
});

function Opened() {
  const { id } = useParams();
  return <div data-testid="opened">{id}</div>;
}

function renderCompose(client: MockClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={["/new"]}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} platform={webPlatform} queryClient={queryClient}>
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

function composerBox(): HTMLTextAreaElement {
  // UI95: the visible placeholder is the compact "Message…"; the full resolved
  // prompt stays the accessible name, which is the stable hook here.
  const box = screen.getByRole("textbox", { name: /^Message/ });
  if (!(box instanceof HTMLTextAreaElement)) throw new Error("missing shared composer");
  return box;
}

function submitComposer(box: HTMLElement): void {
  const form = box.closest("form");
  if (!form) throw new Error("composer form not found");
  fireEvent.submit(form);
}

function roomModeOf(body: CapturedBody | undefined): unknown {
  if (body === undefined || !("roomMode" in body)) return undefined;
  return body.roomMode;
}

describe("ComposeConversation immediate creation", () => {
  it("uses the shared composer pill on a new draft", async () => {
    const base = createMockClient({ seed: 31 });
    await base.agents.create({ name: "Ava" });
    renderCompose(base);
    await screen.findByText("Ava");
    expect(document.querySelectorAll("form.composer-pill")).toHaveLength(1);
    expect(composerBox()).toBeTruthy();
  });

  it("creates a new agent immediately and opens its chat without a first message", async () => {
    const base = createMockClient({ seed: 32 });
    await base.agents.create({ name: "Ava" });
    const agentCalls: unknown[] = [];
    const bodies: CapturedBody[] = [];
    const client: MockClient = {
      ...base,
      agents: {
        ...base.agents,
        create: async (input) => {
          agentCalls.push(input);
          return base.agents.create(input);
        },
      },
      conversations: {
        ...base.conversations,
        create: async (input) => {
          bodies.push({ ...input });
          return base.conversations.create(input);
        },
      },
    };
    renderCompose(client);
    fireEvent.click(await screen.findByText("Create new agent"));
    await screen.findByTestId("opened");
    expect(agentCalls).toHaveLength(1);
    // A blank agent omits the name: the server picks a unique one.
    expect(agentCalls[0]).toEqual({});
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.kind).toBe("direct");
    expect(bodies[0]?.firstMessage).toBeUndefined();
  });

  it("opens an existing agent's private chat without creating anything", async () => {
    const base = createMockClient({ seed: 33 });
    const ava = await base.agents.create({ name: "Ava" });
    let agentCalls = 0;
    let convCalls = 0;
    const client: MockClient = {
      ...base,
      agents: {
        ...base.agents,
        create: async (input) => {
          agentCalls += 1;
          return base.agents.create(input);
        },
      },
      conversations: {
        ...base.conversations,
        create: async (input) => {
          convCalls += 1;
          return base.conversations.create(input);
        },
      },
    };
    renderCompose(client);
    fireEvent.click(await screen.findByText("Ava"));
    const opened = await screen.findByTestId("opened");
    expect(opened.textContent ?? "").not.toBe("");
    expect(agentCalls).toBe(0);
    expect(convCalls).toBe(0);
    expect(ava.id).toBeTruthy();
  });

  it("retries a failed direct open against the same thread", async () => {
    const base = createMockClient({ seed: 34 });
    await base.agents.create({ name: "Ava" });
    const bodies: CapturedBody[] = [];
    let convCalls = 0;
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        list: async () => ({ items: [], nextCursor: null }),
        create: async (input) => {
          convCalls += 1;
          bodies.push({ ...input });
          if (convCalls === 1) throw new Error("direct failed");
          return base.conversations.create(input);
        },
      },
    };
    renderCompose(client);
    fireEvent.click(await screen.findByText("Ava"));
    await screen.findByRole("alert");
    expect(convCalls).toBe(1);
    // The picker stays open so the row is still actionable, with an enabled retry.
    expect(screen.getByText("Ava")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("opened");
    expect(convCalls).toBe(2);
    expect(bodies[0]?.requestId).toBeDefined();
    expect(bodies[0]?.requestId).toBe(bodies[1]?.requestId);
  });
});

describe("ComposeConversation group mode", () => {
  it("creates a mention-default room titled with member names and no message", async () => {
    const base = createMockClient({ seed: 35 });
    await base.agents.create({ name: "Nova" });
    await base.agents.create({ name: "Milo" });
    const bodies: CapturedBody[] = [];
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        create: async (input) => {
          bodies.push({ ...input });
          return base.conversations.create(input);
        },
      },
    };
    renderCompose(client);
    fireEvent.click(await screen.findByText(FIRST_AGENT_COPY.newGroupChat));
    fireEvent.click(await screen.findByText("Nova"));
    fireEvent.click(await screen.findByText("Milo"));
    fireEvent.click(await screen.findByRole("button", { name: "Create group (2)" }));
    await screen.findByTestId("opened");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.kind).toBe("room");
    expect(bodies[0]?.firstMessage).toBeUndefined();
    expect(roomModeOf(bodies[0])).toBe("mention");
    expect(bodies[0]?.title ?? "").toContain("Nova");
    expect(bodies[0]?.title ?? "").toContain("Milo");
  });

  it("requires at least two members and caps groups at six", async () => {
    const base = createMockClient({ seed: 36 });
    for (let n = 0; n < 7; n += 1) await base.agents.create({ name: "Agent" + n });
    renderCompose(base);
    fireEvent.click(await screen.findByText(FIRST_AGENT_COPY.newGroupChat));
    expect(
      screen.getByRole("button", { name: "Create group (0)" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(await screen.findByText("Agent0"));
    expect(
      screen.getByRole("button", { name: "Create group (1)" }).hasAttribute("disabled"),
    ).toBe(true);
    for (const n of [1, 2, 3, 4, 5]) fireEvent.click(await screen.findByText("Agent" + n));
    expect(
      screen.getByRole("button", { name: "Create group (6)" }).hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(await screen.findByText("Agent6"));
    await screen.findByText(FIRST_AGENT_COPY.groupTooMany);
  });

  it("keeps the kickoff draft and retries the same room on first-send failure", async () => {
    const base = createMockClient({ seed: 37 });
    await base.agents.create({ name: "Nova" });
    await base.agents.create({ name: "Milo" });
    const bodies: CapturedBody[] = [];
    let convCalls = 0;
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        create: async (input) => {
          convCalls += 1;
          bodies.push({ ...input });
          if (convCalls === 1) throw new Error("room failed");
          return base.conversations.create(input);
        },
      },
    };
    renderCompose(client);
    fireEvent.click(await screen.findByText(FIRST_AGENT_COPY.newGroupChat));
    fireEvent.click(await screen.findByText("Nova"));
    fireEvent.click(await screen.findByText("Milo"));
    const box = composerBox();
    fireEvent.change(box, { target: { value: "kickoff" } });
    submitComposer(box);
    await screen.findByRole("alert");
    expect(composerBox().value).toBe("kickoff");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("opened");
    expect(convCalls).toBe(2);
    expect(bodies[0]?.requestId).toBe(bodies[1]?.requestId);
    expect(bodies[1]?.firstMessage).toMatchObject({ text: "kickoff" });
  });

  it("opens an existing group without creating or requiring a send", async () => {
    const base = createMockClient({ seed: 38 });
    const nova = await base.agents.create({ name: "Nova" });
    const milo = await base.agents.create({ name: "Milo" });
    await base.conversations.create({
      kind: "room",
      memberAgentIds: [nova.id, milo.id],
      title: "Sales Outbound",
    });
    let convCalls = 0;
    const client: MockClient = {
      ...base,
      conversations: {
        ...base.conversations,
        create: async (input) => {
          convCalls += 1;
          return base.conversations.create(input);
        },
      },
    };
    renderCompose(client);
    fireEvent.click(await screen.findByText("Sales Outbound"));
    await screen.findByTestId("opened");
    expect(convCalls).toBe(0);
  });
});
