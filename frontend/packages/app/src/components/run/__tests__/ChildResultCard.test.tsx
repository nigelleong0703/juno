/**
 * CT-ui: parent cards read the child result from canonical scoped run state.
 * Each test renders the actual ChildRuns component with a fake public client —
 * source-level asserts are not enough.
 */
import type { Agent, ApiClient, Run } from "@agent-desktop/client";
import { EventType } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { applyEvent } from "../../../data/liveSync";
import { qk } from "../../../data/keys";
import { t } from "../../../lib/i18n";
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
const CHILD = "run-child-1";
const AT = "2026-10-08T00:00:00.000Z";
const RESULT = "canonical child result";

function makeRun(seed: { id: string; status: Run["status"]; childResult?: string }): Run {
  return {
    id: seed.id,
    agentId: "agent-a",
    conversationId: CONV,
    title: seed.id,
    status: seed.status,
    kind: "chat",
    steps: [],
    engine: undefined,
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: AT,
    lastActivityAt: AT,
    ...(seed.id === CHILD ? { parentRunId: PARENT } : {}),
    ...(seed.childResult === undefined ? {} : { childResult: seed.childResult }),
  };
}

function clientWith(runs: Run[], opts: { failRuns?: boolean; onGet?: (id: string) => void; gotRuns?: Map<string, Run> } = {}): ApiClient {
  const base = createMockClient({ seed: 11 });
  const current = runs;
  const get = async (id: string) => {
    opts.onGet?.(id);
    if (opts.failRuns) throw new Error("run unavailable");
    const got = opts.gotRuns?.get(id);
    if (got) return got;
    const found = current.find((run) => run.id === id);
    if (!found) throw new Error("run not found: " + id);
    return found;
  };
  return {
    ...base,
    runs: {
      ...base.runs,
      list: async () => ({ items: current, nextCursor: null }),
      get,
    },
    conversations: {
      ...base.conversations,
      items: async () => ({ items: [], nextCursor: null }),
    },
  };
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

const AGENT: Agent = {
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
};

function renderChildren(client: ApiClient, queryClient: QueryClient = newQueryClient()) {
  return render(
    <ChildRuns parentRunId={PARENT} conversationId={CONV} agentById={(id) => (id === "agent-a" ? AGENT : undefined)} onOpenRun={vi.fn()} onStopRun={vi.fn()} />,
    { wrapper: wrapperFor(client, queryClient) },
  );
}

describe("ChildResultCard", () => {
  it("renders the childResult of a completed child from canonical run state", async () => {
    const { container } = renderChildren(
      clientWith([makeRun({ id: PARENT, status: "running" }), makeRun({ id: CHILD, status: "completed", childResult: RESULT })]),
    );
    expect(await screen.findByTestId("child-run-" + CHILD)).toBeDefined();
    expect(await screen.findByText(RESULT)).toBeDefined();
    expect(screen.queryByText("CHILD-ITEM-REPLY")).toBeNull();
    expect(container.hasChildNodes()).toBe(true);
  });

  it("keeps the result without any child chat bubble", async () => {
    renderChildren(
      clientWith([makeRun({ id: PARENT, status: "running" }), makeRun({ id: CHILD, status: "completed", childResult: RESULT })]),
    );
    expect(await screen.findByTestId("child-run-" + CHILD)).toBeDefined();
    expect(await screen.findByText(RESULT)).toBeDefined();
    expect(screen.queryByText("CHILD-ITEM-REPLY")).toBeNull();
    expect(screen.queryByRole("button", { name: t("run.stop") + " " + CHILD })).toBeNull();
    expect(screen.getByRole("button", { name: t("chat.thread.open") + " " + CHILD })).toBeDefined();
  });

  it("picks up a live run.updated carrying the childResult, without a refetch", async () => {
    const onGet = vi.fn();
    const queryClient = newQueryClient();
    renderChildren(clientWith([makeRun({ id: PARENT, status: "running" }), makeRun({ id: CHILD, status: "running" })], { onGet }), queryClient);
    expect(await screen.findByTestId("child-run-" + CHILD)).toBeDefined();
    expect(screen.queryByText(RESULT)).toBeNull();
    const before = onGet.mock.calls.length;
    applyEvent(queryClient, {
      type: EventType.CUSTOM,
      name: "juno.run.updated",
      value: { ...makeRun({ id: CHILD, status: "completed", childResult: RESULT }), finishedAt: AT },
      metadata: { juno: { runId: CHILD, conversationId: CONV } },
    });
    expect(await screen.findByText(RESULT)).toBeDefined();
    expect(onGet.mock.calls.length).toBe(before);
  });

  it("refetches through the run API and shows the reloaded result", async () => {
    const current = [makeRun({ id: PARENT, status: "running" }), makeRun({ id: CHILD, status: "running" })];
    const onGet = vi.fn();
    const queryClient = newQueryClient();
    renderChildren(clientWith(current, { onGet }), queryClient);
    await screen.findByTestId("child-run-" + CHILD);
    await waitFor(() => expect(onGet).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(RESULT)).toBeNull();
    current.splice(1, 1, makeRun({ id: CHILD, status: "completed", childResult: RESULT }));
    await queryClient.refetchQueries({ queryKey: qk.run(CHILD), exact: true });
    expect(await screen.findByText(RESULT)).toBeDefined();
    expect(onGet).toHaveBeenCalledTimes(2);
  });

  it("clears a stale result when the reload drops childResult", async () => {
    const current = [makeRun({ id: PARENT, status: "running" }), makeRun({ id: CHILD, status: "completed", childResult: RESULT })];
    const queryClient = newQueryClient();
    renderChildren(clientWith(current), queryClient);
    expect(await screen.findByText(RESULT)).toBeDefined();
    current.splice(1, 1, makeRun({ id: CHILD, status: "completed" }));
    await queryClient.refetchQueries({ queryKey: qk.run(CHILD), exact: true });
    await waitFor(() => expect(screen.queryByText(RESULT)).toBeNull());
  });

  it("hides a row whose list run carries a foreign scope", async () => {
    const foreign = { ...makeRun({ id: CHILD, status: "completed", childResult: "FOREIGN RESULT" }) };
    foreign.agentId = "agent-other";
    foreign.conversationId = "conv-other";
    renderChildren(
      clientWith([makeRun({ id: PARENT, status: "running" }), foreign]),
    );
    expect(screen.queryByText("FOREIGN RESULT")).toBeNull();
  });

  it("refuses a foreign-scope run fetched by id even when the list row passes", async () => {
    const foreign = { ...makeRun({ id: CHILD, status: "completed", childResult: "FOREIGN RESULT" }) };
    foreign.conversationId = undefined;
    foreign.agentId = "agent-other";
    renderChildren(
      clientWith(
        [makeRun({ id: PARENT, status: "running" }), makeRun({ id: CHILD, status: "completed", childResult: undefined })],
        { gotRuns: new Map([[CHILD, foreign]]) },
      ),
    );
    expect(await screen.findByTestId("child-run-" + CHILD)).toBeDefined();
    await waitFor(() => expect(screen.queryByText("FOREIGN RESULT")).toBeNull());
    expect(screen.queryByRole("button", { name: t("common.retry") })).toBeNull();
  });

  it("refuses a childResult when the canonical run id does not match the child id, not through query-key matching", async () => {
    const other = { ...makeRun({ id: CHILD, status: "completed", childResult: "FOREIGN RESULT" }) };
    other.id = "run-child-2";
    renderChildren(
      clientWith(
        [makeRun({ id: PARENT, status: "running" }), makeRun({ id: CHILD, status: "completed", childResult: undefined })],
        { gotRuns: new Map([[CHILD, other]]) },
      ),
    );
    expect(await screen.findByTestId("child-run-" + CHILD)).toBeDefined();
    await waitFor(() => expect(screen.queryByText("FOREIGN RESULT")).toBeNull());
  });

  it("refuses a childResult when the run by id lacks its conversation scope", async () => {
    const noConv = { ...makeRun({ id: CHILD, status: "completed", childResult: "FOREIGN RESULT" }) };
    noConv.conversationId = undefined;
    noConv.agentId = "agent-a";
    renderChildren(
      clientWith(
        [makeRun({ id: PARENT, status: "running" }), makeRun({ id: CHILD, status: "completed", childResult: undefined })],
        { gotRuns: new Map([[CHILD, noConv]]) },
      ),
    );
    expect(await screen.findByTestId("child-run-" + CHILD)).toBeDefined();
    await waitFor(() => expect(screen.queryByText("FOREIGN RESULT")).toBeNull());
    expect(screen.queryByRole("button", { name: t("common.retry") })).toBeNull();
  });
});
