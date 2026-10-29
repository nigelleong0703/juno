import type { Agent, ApiClient, ComposerPayload, Conversation, Item, Run } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ClientProvider } from "../../../data/ClientProvider";
import { dragRegion, noDragRegion } from "../../../lib/drag";
import { t } from "../../../lib/i18n";
import { useUiStore } from "../../../store/ui";
import { ConversationView, type ConversationViewProps } from "../ConversationView";

// jsdom lacks ResizeObserver, which the ui surfaces read on mount. Radix popovers
// also expect scrollIntoView for positioning.
beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

// vitest runs without globals, so testing-library's automatic cleanup is not registered.
afterEach(cleanup);

const ISO = "2026-10-05T09:30:00.000Z";

function makeAgent(input: {
  id: string;
  name: string;
  title?: string;
  pinned?: boolean;
}): Agent {
  return {
    id: input.id,
    name: input.name,
    handle: input.name.toLowerCase(),
    avatar: { shape: "circle", color: 1, eyes: "dot" },
    title: input.title ?? "Aide",
    status: "idle",
    section: "Work",
    pinned: input.pinned ?? false,
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
}

function makeConversation(input: {
  id: string;
  kind?: Conversation["kind"];
  title?: string;
  agentIds?: string[];
}): Conversation {
  return {
    id: input.id,
    kind: input.kind ?? "direct",
    title: input.title,
    agentIds: input.agentIds ?? ["agent-1"],
    memberIds: ["member-robin"],
    unreadCount: 0,
    lastItemAt: ISO,
    createdAt: ISO,
  };
}

function makeRun(input: { id: string; conversationId?: string; title: string; status?: Run["status"] }): Run {
  return {
    id: input.id,
    agentId: "agent-1",
    conversationId: input.conversationId,
    title: input.title,
    status: input.status ?? "running",
    kind: "chat",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: ISO,
    lastActivityAt: ISO,
  };
}

const AGENT = makeAgent({ id: "agent-1", name: "Juno", title: "Research & inbox" });
const CONVERSATION = makeConversation({ id: "conv-1" });

interface ViewOverrides {
  conversation?: Conversation;
  items?: Item[];
  runningRuns?: Run[];
  isLoading?: boolean;
  isError?: boolean;
  computerPanelOpen?: boolean;
  onRetry?: () => void;
  onSend?: (payload: ComposerPayload) => void;
  onSystemAction?: (command: string) => void;
  onStopRun?: (runId: string) => void;
  onOpenRun?: (runId: string) => void;
  agentPanel?: ConversationViewProps["agentPanel"];
}

function viewProps(overrides: ViewOverrides = {}): ConversationViewProps {
  return {
    conversation: overrides.conversation ?? CONVERSATION,
    items: overrides.items ?? [],
    itemsLoading: false,
    agents: [AGENT],
    primaryAgent: AGENT,
    runningRuns: overrides.runningRuns ?? [],
    isLoading: overrides.isLoading ?? false,
    isError: overrides.isError ?? false,
    computerPanelOpen: overrides.computerPanelOpen ?? false,
    onRetry: overrides.onRetry ?? (() => {}),
    onSend: overrides.onSend ?? (() => {}),
    onToggleComputerPanel: () => {},
    onSystemAction: overrides.onSystemAction,
    ...(overrides.onStopRun === undefined ? {} : { onStopRun: overrides.onStopRun }),
    ...(overrides.onOpenRun === undefined ? {} : { onOpenRun: overrides.onOpenRun }),
    onOpenCitation: () => {},
    ...(overrides.agentPanel === undefined ? {} : { agentPanel: overrides.agentPanel }),
  };
}

// The working pill reads its run and the pending requests through the client.
const pillClient = createMockClient({ seed: 3 });

function viewElement(overrides: ViewOverrides = {}) {
  return (
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={pillClient}>
          <ConversationView {...viewProps(overrides)} />
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}

function renderView(overrides: ViewOverrides = {}) {
  return render(viewElement(overrides));
}

describe("ConversationView", () => {
  it("shows a loading state instead of the composer while the conversation loads", () => {
    renderView({ isLoading: true });

    expect(screen.getByText(t("common.loading"))).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("shows an error state whose retry runs the retry action", () => {
    const onRetry = vi.fn();
    renderView({ isError: true, onRetry });

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("sends the typed message through the send action", async () => {
    const onSend = vi.fn();
    renderView({ onSend });

    const textbox = screen.getByRole("textbox", {
      name: t("chat.placeholder", { name: "Juno" }),
    });
    fireEvent.change(textbox, { target: { value: "  hello there  " } });
    const form = textbox.closest("form");
    if (!form) throw new Error("composer form not found");
    fireEvent.submit(form);

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith({ text: "hello there", attachments: [] }),
    );
  });

  it("keeps the header to identity plus computer toggle, without the More menu", () => {
    renderView({});

    expect(screen.queryByRole("button", { name: t("chat.more") })).toBeNull();
    expect(screen.getByRole("button", { name: t("chat.computer.show") })).toBeDefined();
  });
  it("shows the computer toggle unpressed when the pane cannot be open", () => {
    useUiStore.setState({ layoutSynced: false });
    renderView({
      computerPanelOpen: true,
      conversation: makeConversation({ id: "conv-1", agentIds: [] }),
    });

    const toggle = screen.getByRole("button", { name: t("chat.computer.show") });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
  it("follows the shell displayed pane once synced", () => {
    useUiStore.getState().setDisplayedLayout({ sidebarCollapsed: false, computerOpen: true });
    renderView({ computerPanelOpen: false });

    const toggle = screen.getByRole("button", { name: t("chat.computer.hide") });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    useUiStore.setState({
      layoutSynced: false,
      displayedComputerOpen: false,
      displayedSidebarCollapsed: false,
    });
  });
  it("shows only the typing bubble after send (no status box), opens Activity from it, and keeps it under interim text until the run ends", async () => {
    const onSend = vi.fn();
    const onOpenRun = vi.fn();
    const run = makeRun({ id: "run-1", conversationId: "conv-1", title: "Working" });
    const old: Item = {
      id: "item-old",
      conversationId: "conv-1",
      at: ISO,
      type: "agent_message",
      agentId: "agent-1",
      markdown: "Old news",
      citations: [],
    };
    const sentProps = { onSend, onOpenRun, runningRuns: [run], items: [old] };
    const { rerender } = renderView(sentProps);

    const textbox = screen.getByRole("textbox", {
      name: t("chat.placeholder", { name: "Juno" }),
    });
    fireEvent.change(textbox, { target: { value: "hello there" } });
    const form = textbox.closest("form");
    if (!form) throw new Error("composer form not found");
    fireEvent.submit(form);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // The send ref flips without a state change, so surface it the way a parent
    // re-render (e.g. the mutation's pending flip) would.
    rerender(viewElement(sentProps));
    // The typing bubble is the only working indicator: no status box above the composer.
    await waitFor(() => expect(screen.getByTestId("transcript-awaiting")).toBeDefined());
    expect(document.querySelector('[data-slot="agent-status-pill"]')).toBeNull();
    expect(document.querySelector('[data-slot="agent-status-open"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("transcript.openActivity") }));
    expect(onOpenRun).toHaveBeenCalledWith("run-1");

    const reply: Item = {
      id: "item-reply",
      conversationId: "conv-1",
      at: new Date(Date.now() + 1000).toISOString(),
      type: "agent_message",
      agentId: "agent-1",
      markdown: "Here you go",
      citations: [],
    };
    rerender(viewElement({ onSend, runningRuns: [run], items: [old, reply] }));
    // Interim text, the run keeps working: the bubble stays under the newest message.
    expect(screen.getByText("Here you go")).toBeDefined();
    expect(screen.getByTestId("transcript-awaiting")).toBeDefined();
    // Waiting for approval: no bubble (the card is inline); working again: it returns.
    rerender(viewElement({ onSend, runningRuns: [{ ...run, status: "waiting_for_input" }], items: [old, reply] }));
    expect(screen.queryByTestId("transcript-awaiting")).toBeNull();
    rerender(viewElement({ onSend, runningRuns: [run], items: [old, reply] }));
    expect(screen.getByTestId("transcript-awaiting")).toBeDefined();
    // The run ends: gone.
    rerender(viewElement({ onSend, runningRuns: [{ ...run, status: "completed" }], items: [old, reply] }));
    expect(screen.queryByTestId("transcript-awaiting")).toBeNull();
  });
  it("shows the typing bubble for a run already going when the chat opens, but not while it waits for approval", () => {
    const old: Item = {
      id: "item-old",
      conversationId: "conv-1",
      at: ISO,
      type: "agent_message",
      agentId: "agent-1",
      markdown: "Old news",
      citations: [],
    };
    renderView({
      runningRuns: [makeRun({ id: "run-1", conversationId: "conv-1", title: "Working" })],
      items: [old],
    });
    expect(screen.getByTestId("transcript-awaiting")).toBeDefined();
    cleanup();

    renderView({
      runningRuns: [makeRun({ id: "run-1", conversationId: "conv-1", title: "Working", status: "waiting_for_input" })],
      items: [old],
    });
    expect(screen.queryByTestId("transcript-awaiting")).toBeNull();
  });

  it("ignores a running run that belongs to a different conversation", () => {
    renderView({
      runningRuns: [
        makeRun({ id: "run-other", conversationId: "conv-2", title: "Someone else's task" }),
      ],
    });

    expect(
      screen.queryByText(t("chat.status.workingOn", { title: "Someone else's task" })),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDefined();
  });

  it("H-93: shows Stop for this chat's running run and stops that run", () => {
    const stopped: string[] = [];
    renderView({
      runningRuns: [makeRun({ id: "run-live", conversationId: "conv-1", title: "Working" })],
      onStopRun: (runId) => stopped.push(runId),
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stopped).toEqual(["run-live"]);
  });

  it("H-93: drops the Stop control once the run in the cached list has finished", () => {
    renderView({
      runningRuns: [makeRun({ id: "run-done", conversationId: "conv-1", title: "Working", status: "stopped" })],
      onStopRun: () => {},
    });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDefined();
  });

  it("H-94: shows Stop for this chat's run waiting for the user's answer and stops that run", () => {
    const stopped: string[] = [];
    renderView({
      runningRuns: [
        makeRun({
          id: "run-wait",
          conversationId: "conv-1",
          title: "Needs approval",
          status: "waiting_for_input",
        }),
      ],
      onStopRun: (runId) => stopped.push(runId),
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stopped).toEqual(["run-wait"]);
  });

  it("H-94: Stop targets the chat's own waiting run rather than a child run of this chat", () => {
    const stopped: string[] = [];
    const child: Run = {
      ...makeRun({ id: "run-child", conversationId: "conv-1", title: "Child", status: "running" }),
      parentRunId: "run-parent",
    };
    renderView({
      runningRuns: [
        child,
        makeRun({ id: "run-parent", conversationId: "conv-1", title: "Parent", status: "waiting_for_input" }),
      ],
      onStopRun: (runId) => stopped.push(runId),
    });
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stopped).toEqual(["run-parent"]);
  });

  it("H-94: shows no Stop for a finished run of this chat", () => {
    for (const status of ["completed", "failed", "stopped", "blocked"] as const) {
      const { unmount } = renderView({
        runningRuns: [makeRun({ id: `run-${status}`, conversationId: "conv-1", title: "Done", status })],
        onStopRun: () => {},
      });
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      unmount();
    }
  });

  it("H-94: a run waiting for the user shows no agent-replying bubble after a send", async () => {
    const onSend = vi.fn();
    const run = makeRun({
      id: "run-wait",
      conversationId: "conv-1",
      title: "Needs approval",
      status: "waiting_for_input",
    });
    const sentProps = { onSend, runningRuns: [run], onStopRun: () => {} };
    const { rerender } = renderView(sentProps);

    const textbox = screen.getByRole("textbox", {
      name: t("chat.placeholder", { name: "Juno" }),
    });
    fireEvent.change(textbox, { target: { value: "approve it" } });
    const form = textbox.closest("form");
    if (!form) throw new Error("composer form not found");
    fireEvent.submit(form);
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    rerender(viewElement(sentProps));

    expect(screen.queryByTestId("transcript-awaiting")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
  });

  it("keeps run status out of the header and shows no stop without a stop handler", () => {
    renderView({
      runningRuns: [makeRun({ id: "run-1", conversationId: "conv-1", title: "Reading the inbox" })],
    });

    const header = document.querySelector("[data-titlebar]");
    if (!(header instanceof HTMLElement)) throw new Error("conversation header not found");
    expect(header.textContent).not.toContain("Reading the inbox");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Submit" })).toBeDefined();
  });

  it("dispatches a system row action through onSystemAction", () => {
    const onSystemAction = vi.fn();
    renderView({
      items: [
        {
          id: "item-sys",
          conversationId: "conv-1",
          at: ISO,
          type: "system",
          level: "info",
          text: "Computer resumed after being paused while you were away.",
          action: { label: "View computer", command: "computer.open" },
        },
      ],
      onSystemAction,
    });

    fireEvent.click(screen.getByRole("button", { name: /view computer/i }));

    expect(onSystemAction).toHaveBeenCalledWith("computer.open");
  });
});

describe("ConversationView footer fade (SF1)", () => {
  it("anchors the composer fade overlay in a footer positioning wrapper", () => {
    renderView({});

    const footer = document.querySelector(".conversation-footer");
    if (!(footer instanceof HTMLElement)) throw new Error("footer wrapper not found");
    expect(footer.querySelector("form")).not.toBeNull();
    expect(footer.querySelector(".composer-fade")).not.toBeNull();
  });
});

describe("ConversationView scroll-under-composer measurement (UI92)", () => {
  it("measures the footer once the body mounts after loading with a stable conversation id", () => {
    const { container, rerender } = renderView({ isLoading: true });
    expect(container.querySelector('[data-slot="conversation-thread-body"]')).toBeNull();

    rerender(viewElement({ isLoading: false }));

    const body = container.querySelector('[data-slot="conversation-thread-body"]');
    if (!(body instanceof HTMLElement)) throw new Error("thread body not found");
    // The ResizeObserver starts only when the body mounts under the same conversation id;
    // a stale dependency left `--conversation-footer-height` unset across this transition.
    expect(body.style.getPropertyValue("--conversation-footer-height")).not.toBe("");
  });
});

describe("ConversationView centered agent header (UI87)", () => {
  async function renderHeaderEditor(input: {
    kind: Conversation["kind"];
    title?: string;
    agentIds: string[];
  }): Promise<{ client: ApiClient; agents: Agent[]; primary: Agent }> {
    const client = createMockClient({ seed: 3 });
    const agents: Agent[] = [];
    for (const id of input.agentIds) {
      agents.push(await client.agents.get(id));
    }
    const primary = agents[0];
    if (primary === undefined) throw new Error("no agents");
    const conversation: Conversation = {
      id: "conv-ui87",
      kind: input.kind,
      title: input.title,
      agentIds: input.agentIds,
      memberIds: ["member-robin"],
      unreadCount: 0,
      lastItemAt: ISO,
      createdAt: ISO,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} queryClient={queryClient}>
            <MemoryRouter>
              <ConversationView
                {...viewProps({ conversation, items: [], runningRuns: [] })}
                agents={agents}
                primaryAgent={primary}
              />
            </MemoryRouter>
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    return { client, agents, primary };
  }

  it("centers a compact avatar-over-pill trigger in the panel grid", () => {
    renderView({});

    const trigger = screen.getByRole("button", { name: "Open Juno" });
    expect(trigger.getAttribute("data-slot")).toBe("agent-header-trigger");
    expect(trigger.textContent).toContain("Juno");
    // The name pill truncates instead of overflowing at small widths.
    const pill = trigger.querySelector(".max-w-56");
    expect(pill?.getAttribute("class")).toContain("max-w-56");
    expect(pill?.querySelector(".truncate")).not.toBeNull();

    const header = document.querySelector("[data-titlebar]");
    if (!(header instanceof HTMLElement)) throw new Error("conversation header not found");
    expect(header.className).toContain("grid-cols-[1fr_auto_1fr]");
    expect(header.getAttribute("data-slot")).toBe("conversation-header");
    expect(header.className).toContain("conversation-header");
    expect(header.className).toContain("h-[120px]");
    expect(header.className).not.toContain("border-b");
    // Native drag stays on the header; the trigger opts out so it remains clickable.
    // jsdom drops `-webkit-app-region` from inline styles (see ComputerHeaderDrag), so pin the
    // exact style objects the header and the trigger apply instead of the serialized attribute.
    expect(dragRegion).toEqual({ WebkitAppRegion: "drag" });
    expect(noDragRegion).toEqual({ WebkitAppRegion: "no-drag" });
  });

  it("puts the header avatar in the management dropdown slot and opens the workspace from the computer button", () => {
    renderView({ agentPanel: (trigger) => <div data-testid="agent-panel-slot">{trigger}</div> });

    expect(screen.getByTestId("agent-panel-slot").contains(screen.getByRole("button", { name: "Open Juno" }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: t("chat.computer.show") }));
    expect(useUiStore.getState().computerPanelOpen).toBe(true);
  });

  it("shows the group header trigger, and the computer button opens a member's workspace", async () => {
    await renderHeaderEditor({ kind: "room", title: "Launch prep", agentIds: ["agent-juno", "agent-patch"] });

    const trigger = screen.getByRole("button", { name: "Show members" });
    expect(trigger.getAttribute("data-slot")).toBe("agent-header-trigger");
    expect(trigger.textContent).toContain("Launch prep");

    fireEvent.click(screen.getByRole("button", { name: t("chat.computer.show") }));
    expect(useUiStore.getState()).toMatchObject({ computerPanelOpen: true, workspaceAgentId: "agent-juno" });
  });
});
