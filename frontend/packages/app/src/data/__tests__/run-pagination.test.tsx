import type { ApiClient, Run, RunsListParams, RunStatus } from "@agent-desktop/client";
import { EventType } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { GroupMemberRunStatus } from "../../components/conversation/GroupMemberRunStatus";
import { t } from "../../lib/i18n";
import { ClientProvider } from "../ClientProvider";
import { applyEvent } from "../liveSync";
import { useRuns } from "../queries";

afterEach(cleanup);

const CONV = "conv-group";

interface Page {
  items: Run[];
  nextCursor: string | null;
}

interface RunSeed {
  id: string;
  agentId: string;
  status: RunStatus;
  conversationId?: string;
  startedAt?: string;
  lastActivityAt?: string;
}

function makeRun(seed: RunSeed): Run {
  const startedAt = seed.startedAt ?? "2026-10-08T00:00:00.000Z";
  return {
    id: seed.id,
    agentId: seed.agentId,
    conversationId: seed.conversationId ?? CONV,
    title: seed.id,
    status: seed.status,
    kind: "chat",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt,
    lastActivityAt: seed.lastActivityAt ?? startedAt,
  };
}

/** A client whose runs endpoint returns the seeded page for each cursor (null = the first page). */
function pagedClient(pages: Map<string | null, Page>): { client: ApiClient; calls: (RunsListParams | undefined)[] } {
  const calls: (RunsListParams | undefined)[] = [];
  const base = createMockClient({ seed: 7 });
  return {
    calls,
    client: {
      ...base,
      runs: {
        ...base.runs,
        list: async (params?: RunsListParams) => {
          calls.push(params);
          const page = pages.get(params?.cursor ?? null);
          if (!page) throw new Error("no seeded page for cursor " + String(params?.cursor ?? null));
          return page;
        },
      },
    },
  };
}

function wrapperFor(client: ApiClient, queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={queryClient}>
      {children}
    </ClientProvider>
  );
}

function newQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe("useRuns pagination", () => {
  it("walks every cursor page, keeps the caller's filters and renders the run from the last page", async () => {
    const { client, calls } = pagedClient(
      new Map<string | null, Page>([
        [
          null,
          {
            items: [makeRun({ id: "run-old", agentId: "agent-a", status: "completed" })],
            nextCursor: "c1",
          },
        ],
        [
          "c1",
          {
            items: [
              makeRun({
                id: "run-new",
                agentId: "agent-a",
                status: "running",
                startedAt: "2026-10-08T01:00:00.000Z",
              }),
            ],
            nextCursor: null,
          },
        ],
      ]),
    );
    const queryClient = newQueryClient();
    render(<GroupMemberRunStatus conversationId={CONV} agentId="agent-a" />, {
      wrapper: wrapperFor(client, queryClient),
    });

    // The newest run lives on the second page; a first-page-only read would still show completed.
    expect(await screen.findByText(t("status.run.running"))).toBeDefined();
    expect(screen.queryByText(t("status.run.completed"))).toBeNull();

    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[0]).toEqual({ conversationId: CONV });
    expect(calls[1]).toEqual({ conversationId: CONV, cursor: "c1" });
    expect(queryClient.getQueryData<Run[]>(["runs", { conversationId: CONV }])).toHaveLength(2);

    // The shared cache entry stays the SSE target: finishing the run flips the pill.
    applyEvent(queryClient, {
      type: EventType.CUSTOM,
      name: "juno.run.updated",
      value: makeRun({
        id: "run-new",
        agentId: "agent-a",
        status: "completed",
        lastActivityAt: "2026-10-08T02:00:00.000Z",
      }),
      metadata: { juno: { runId: "run-new", conversationId: CONV } },
    });
    expect(await screen.findByText(t("status.run.completed"))).toBeDefined();
    expect(screen.queryByText(t("status.run.running"))).toBeNull();
  });

  it("reads a single page when the backend returns no further cursor", async () => {
    const { client, calls } = pagedClient(
      new Map<string | null, Page>([
        [null, { items: [makeRun({ id: "run-1", agentId: "agent-a", status: "running" })], nextCursor: null }],
      ]),
    );
    const { result } = renderHook(() => useRuns({ conversationId: CONV }), {
      wrapper: wrapperFor(client, newQueryClient()),
    });

    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(calls).toEqual([{ conversationId: CONV }]);
  });

  it("surfaces an error instead of paging forever when the backend repeats a cursor", async () => {
    const calls: (RunsListParams | undefined)[] = [];
    const base = createMockClient({ seed: 7 });
    const client: ApiClient = {
      ...base,
      runs: {
        ...base.runs,
        list: async (params?: RunsListParams) => {
          calls.push(params);
          return { items: [makeRun({ id: "run-1", agentId: "agent-a", status: "running" })], nextCursor: "c1" };
        },
      },
    };
    const queryClient = newQueryClient();
    const { result } = renderHook(() => useRuns({ conversationId: CONV }), {
      wrapper: wrapperFor(client, queryClient),
    });

    await waitFor(() =>
      expect(queryClient.getQueryState(["runs", { conversationId: CONV }])?.status).toBe("error"),
    );
    expect(result.current.isError).toBe(true);
    // First page plus one repeat attempt — the cycle is detected, not retried without bound.
    expect(calls.length).toBe(2);
  });
});
