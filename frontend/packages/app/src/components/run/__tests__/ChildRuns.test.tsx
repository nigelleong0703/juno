/**
 * PH12 visible child runs: the original chat shows each child under its parent with the exact
 * run id, truthful status, target agent and the child own reply — linked to the existing run
 * thread, cancellable through the actual run callback, and never a hidden conversation.
 */
import type { Agent, ApiClient, Item, Run, RunStatus } from "@agent-desktop/client";
import { EventType } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { applyEvent } from "../../../data/liveSync";
import { t } from "../../../lib/i18n";
import { Transcript } from "../../conversation/Transcript";
import { ChildRuns } from "../ChildRuns";

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

const CONV = "conv-1";
const PARENT = "run-parent";
const AT = "2026-10-08T00:00:00.000Z";

interface Seed {
  id: string;
  agentId: string;
  status: RunStatus;
  title?: string;
  parentRunId?: string;
  conversationId?: string;
  childResult?: string;
}

function makeRun(seed: Seed): Run {
  return {
    id: seed.id,
    agentId: seed.agentId,
    conversationId: seed.conversationId ?? CONV,
    title: seed.title ?? seed.id,
    status: seed.status,
    kind: "chat",
    steps: [],
    engine: undefined,
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT,
    lastActivityAt: AT,
    ...(seed.parentRunId === undefined ? {} : { parentRunId: seed.parentRunId }),
    ...(seed.childResult === undefined ? {} : { childResult: seed.childResult }),
  };
}

function reply(id: string, runId: string | undefined, agentId: string, markdown: string, at: string = AT): Item {
  return {
    id,
    conversationId: CONV,
    at,
    type: "agent_message",
    agentId,
    ...(runId === undefined ? {} : { runId }),
    markdown,
    citations: [],
  };
}

function parentRunItem(): Item {
  return { id: "itm-run-parent", conversationId: CONV, at: AT, type: "run", runId: PARENT };
}

interface ClientOpts {
  runPages?: Map<string | null, Run[]>;
  itemPages?: Map<string | null, Item[]>;
  gotRuns?: Map<string, Run>;
  failRuns?: boolean;
  onRunsList?: () => void;
}

function clientWith(runs: Run[], items: Item[], opts: ClientOpts = {}): ApiClient {
  const base = createMockClient({ seed: 11 });
  const runPages = opts.runPages ?? new Map<string | null, Run[]>([[null, runs]]);
  const itemPages = opts.itemPages ?? new Map<string | null, Item[]>([[null, items]]);
  const client = {
    ...base,
    runs: {
      ...base.runs,
      list: async (params?: { cursor?: string | null }) => {
        opts.onRunsList?.();
        if (opts.failRuns) throw new Error("runs unavailable");
        const key = params?.cursor ?? null;
        const page = runPages.get(key);
        if (page === undefined) throw new Error("no run page for cursor " + String(key));
        const keys = [...runPages.keys()];
        const next = keys[keys.indexOf(key) + 1] ?? null;
        return { items: page, nextCursor: next };
      },
      get: async (id: string) => {
        const got = opts.gotRuns?.get(id);
        if (got) return got;
        const found = [...runPages.values()].flat().find((run) => run.id === id);
        if (!found) throw new Error("run not found: " + id);
        return found;
      },
    },
    conversations: {
      ...base.conversations,
      items: async (_id: string, params?: { cursor?: string | null }) => {
        const key = params?.cursor ?? null;
        const page = itemPages.get(key);
        if (page === undefined) throw new Error("no item page for cursor " + String(key));
        const keys = [...itemPages.keys()];
        const next = keys[keys.indexOf(key) + 1] ?? null;
        return { items: page, nextCursor: next };
      },
    },
  };
  return client;
}

function wrapperFor(client: ApiClient, queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={queryClient}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>{children}</TooltipProvider>
      </ThemeProvider>
    </ClientProvider>
  );
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const AGENTS: Agent[] = [
  {
    id: "agent-a",
    name: "Juno",
    handle: "juno",
    avatar: { shape: "circle", color: 1, eyes: "dot" },
    title: "t",
    status: "idle",
    section: "Work",
    pinned: false,
    lastActivity: "",
    unreadCount: 0,
    model: {
      planner: { provider: "scripted", model: "t" },
      computer: { provider: "scripted", model: "t" },
      fast: { provider: "scripted", model: "t" },
    },
    channels: [],
    macAccess: false,
    skillIds: [],
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdBy: "owner-1",
    createdAt: AT,
    updatedAt: AT,
  },
];

function agentById(id: string): Agent | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

function renderChildren(runs: Run[], items: Item[], props: Partial<Parameters<typeof ChildRuns>[0]> = {}, clientOpts: ClientOpts = {}, queryClient: QueryClient = newQueryClient()) {
  const onOpenRun = vi.fn();
  const onStopRun = vi.fn();
  render(<ChildRuns parentRunId={PARENT} conversationId={CONV} agentById={agentById} onOpenRun={onOpenRun} onStopRun={onStopRun} {...props} />, {
    wrapper: wrapperFor(clientWith(runs, items, clientOpts), queryClient),
  });
  return { onOpenRun, onStopRun, queryClient };
}

describe("ChildRuns", () => {
  it("shows a running child with its exact id, agent and own reply plus open and stop", async () => {
    const { onOpenRun, onStopRun } = renderChildren(
      [makeRun({ id: PARENT, agentId: "agent-a", status: "running" }), makeRun({ id: "run-child-1", agentId: "agent-a", status: "running", title: "Summarize inbox", parentRunId: PARENT, childResult: "CHILD-RESULT" })],
      [],
    );
    expect(await screen.findByTestId("child-run-run-child-1")).toBeDefined();
    expect(screen.getByText(t("status.run.running"))).toBeDefined();
    expect(screen.getByText(/Juno/)).toBeDefined();
    expect(await screen.findByText("CHILD-RESULT")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: t("chat.thread.open") + " run-child-1" }));
    expect(onOpenRun).toHaveBeenCalledWith("run-child-1");
    fireEvent.click(screen.getByRole("button", { name: t("run.stop") + " run-child-1" }));
    expect(onStopRun).toHaveBeenCalledWith("run-child-1");
  });

  it("lets queued and waiting children stop too", async () => {
    renderChildren(
      [
        makeRun({ id: PARENT, agentId: "agent-a", status: "running" }),
        makeRun({ id: "run-queued", agentId: "agent-a", status: "queued", parentRunId: PARENT }),
        makeRun({ id: "run-waiting", agentId: "agent-a", status: "waiting_for_input", parentRunId: PARENT }),
      ],
      [],
    );
    expect(await screen.findByTestId("child-run-run-queued")).toBeDefined();
    expect(screen.getByText(t("status.run.queued"))).toBeDefined();
    expect(screen.getByText(t("status.run.waiting"))).toBeDefined();
    expect(screen.getByRole("button", { name: t("run.stop") + " run-queued" })).toBeDefined();
    expect(screen.getByRole("button", { name: t("run.stop") + " run-waiting" })).toBeDefined();
  });

  it("shows a completed child with its result and no stop button", async () => {
    renderChildren(
      [makeRun({ id: PARENT, agentId: "agent-a", status: "running" }), makeRun({ id: "run-child-1", agentId: "agent-a", status: "completed", parentRunId: PARENT, childResult: "DONE-BY-CHILD" })],
      [],
    );
    expect(await screen.findByTestId("child-run-run-child-1")).toBeDefined();
    expect(screen.getByText(t("status.run.completed"))).toBeDefined();
    expect(await screen.findByText("DONE-BY-CHILD")).toBeDefined();
    expect(screen.queryByRole("button", { name: t("run.stop") + " run-child-1" })).toBeNull();
  });

  it("shows a blocked child as blocked, never done", async () => {
    renderChildren(
      [makeRun({ id: PARENT, agentId: "agent-a", status: "running" }), makeRun({ id: "run-child-1", agentId: "agent-a", status: "blocked", parentRunId: PARENT })],
      [],
    );
    expect(await screen.findByTestId("child-run-run-child-1")).toBeDefined();
    expect(screen.getByText(t("status.run.blocked"))).toBeDefined();
  });

  it("hides children of another parent in a foreign conversation", async () => {
    const { container } = render(<ChildRuns parentRunId={PARENT} conversationId={CONV} agentById={agentById} />, {
      wrapper: wrapperFor(
        clientWith(
          [
            makeRun({ id: PARENT, agentId: "agent-a", status: "running" }),
            makeRun({ id: "run-foreign", agentId: "agent-a", status: "running", parentRunId: "run-other-parent", conversationId: "conv-other" }),
            makeRun({ id: "run-wrongscope", agentId: "agent-a", status: "running", parentRunId: PARENT, conversationId: "conv-other" }),
          ],
          [],
        ),
        newQueryClient(),
      ),
    });
    await waitFor(() => expect(container.querySelector('[data-testid^="child-run-"]')).toBeNull());
    expect(screen.queryByText("run-foreign")).toBeNull();
    expect(screen.queryByText("run-wrongscope")).toBeNull();
  });

  it("never falls back to a child chat bubble for the result", async () => {
    renderChildren(
      [makeRun({ id: PARENT, agentId: "agent-a", status: "running" }), makeRun({ id: "run-child-1", agentId: "agent-a", status: "completed", parentRunId: PARENT })],
      [
        reply("itm-stale", "run-child-1", "agent-a", "NOT-A-CARD", "2026-10-08T00:00:01.000Z"),
      ],
    );
    expect(await screen.findByTestId("child-run-run-child-1")).toBeDefined();
    expect(screen.queryByText("NOT-A-CARD")).toBeNull();
  });

  it("finds a historical child past the first runs page", async () => {
    renderChildren(
      [],
      [],
      {},
      {
        runPages: new Map<string | null, Run[]>([
          [null, [makeRun({ id: PARENT, agentId: "agent-a", status: "running" })]],
          ["c1", [makeRun({ id: "run-old-child", agentId: "agent-a", status: "completed", parentRunId: PARENT })]],
        ]),
      },
    );
    expect(await screen.findByTestId("child-run-run-old-child")).toBeDefined();
  });

  it("finds a late-page child with its result past the first runs page", async () => {
    renderChildren(
      [],
      [],
      {},
      {
        runPages: new Map<string | null, Run[]>([
          [null, [makeRun({ id: PARENT, agentId: "agent-a", status: "running" })]],
          ["c1", [makeRun({ id: "run-old-child", agentId: "agent-a", status: "completed", parentRunId: PARENT, childResult: "LATE-RESULT" })]],
        ]),
      },
    );
    expect(await screen.findByText("LATE-RESULT")).toBeDefined();
  });

  it("shows loading skeletons then the rows", async () => {
    const gate: { release: ((page: { items: Run[]; nextCursor: null }) => void) | null } = { release: null };
    const base = createMockClient({ seed: 11 });
    const gated: ApiClient = {
      ...base,
      runs: {
        ...base.runs,
        list: () => new Promise<{ items: Run[]; nextCursor: null }>((resolve) => { gate.release = resolve; }),
        get: async (id: string) => makeRun({ id, agentId: "agent-a", status: "running" }),
      },
    };
    const { container } = render(<ChildRuns parentRunId={PARENT} conversationId={CONV} agentById={agentById} />, {
      wrapper: wrapperFor(gated, newQueryClient()),
    });
    expect(container.querySelector('[aria-label="' + t("run.childTask") + '"]')).not.toBeNull();
    expect(container.querySelector('[data-testid^="child-run-"]')).toBeNull();
    gate.release?.({ items: [makeRun({ id: "run-child-1", agentId: "agent-a", status: "running", parentRunId: PARENT })], nextCursor: null });
    expect(await screen.findByTestId("child-run-run-child-1")).toBeDefined();
  });

  it("shows a truthful error with retry when runs fail", async () => {
    let fail = true;
    const base = createMockClient({ seed: 11 });
    const flaky: ApiClient = {
      ...base,
      runs: {
        ...base.runs,
        list: async () => {
          if (fail) throw new Error("runs unavailable");
          return { items: [makeRun({ id: "run-child-1", agentId: "agent-a", status: "running", parentRunId: PARENT })], nextCursor: null };
        },
      },
    };
    render(<ChildRuns parentRunId={PARENT} conversationId={CONV} agentById={agentById} />, {
      wrapper: wrapperFor(flaky, newQueryClient()),
    });
    expect(await screen.findByText(t("common.error"))).toBeDefined();
    fail = false;
    fireEvent.click(screen.getByText(t("common.retry")));
    expect(await screen.findByTestId("child-run-run-child-1")).toBeDefined();
  });

  it("flips the pill when a live run event updates the child", async () => {
    const queryClient = newQueryClient();
    renderChildren(
      [makeRun({ id: PARENT, agentId: "agent-a", status: "running" }), makeRun({ id: "run-child-1", agentId: "agent-a", status: "running", parentRunId: PARENT })],
      [],
      {},
      {},
      queryClient,
    );
    expect(await screen.findByText(t("status.run.running"))).toBeDefined();
    applyEvent(queryClient, {
      type: EventType.CUSTOM,
      name: "juno.run.updated",
      value: makeRun({ id: "run-child-1", agentId: "agent-a", status: "completed", parentRunId: PARENT, childResult: "LIVE-RESULT" }),
      metadata: { juno: { runId: "run-child-1", conversationId: CONV } },
    });
    expect(await screen.findByText(t("status.run.completed"))).toBeDefined();
    expect(await screen.findByText("LIVE-RESULT")).toBeDefined();
  });

  it("renders under the parent run in the original transcript without parent metadata", async () => {
    const onOpenRun = vi.fn();
    render(
      <Transcript items={[parentRunItem(), reply("itm-top", undefined, "agent-a", "TOP-LEVEL-REPLY")]} agentById={agentById} onOpenRun={onOpenRun} />,
      {
        wrapper: wrapperFor(
          clientWith(
            [makeRun({ id: PARENT, agentId: "agent-a", status: "running" }), makeRun({ id: "run-child-1", agentId: "agent-a", status: "completed", parentRunId: PARENT, childResult: "VISIBLE-IN-CARD" })],
            [parentRunItem(), reply("itm-top", undefined, "agent-a", "TOP-LEVEL-REPLY")],
          ),
          newQueryClient(),
        ),
      },
    );
    expect(await screen.findByText("TOP-LEVEL-REPLY")).toBeDefined();
    expect(await screen.findByText("VISIBLE-IN-CARD")).toBeDefined();
    expect(screen.getByTestId("child-run-run-child-1")).toBeDefined();
    expect(screen.queryByText(/parent run-parent/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("chat.thread.open") + " run-child-1" }));
    expect(onOpenRun).toHaveBeenCalledWith("run-child-1");
  });
});
