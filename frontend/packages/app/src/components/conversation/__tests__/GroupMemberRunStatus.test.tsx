import type { ApiClient, Run, RunStatus } from "@agent-desktop/client";
import { EventType } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { applyEvent } from "../../../data/liveSync";
import { t } from "../../../lib/i18n";
import { GroupMemberRunStatus } from "../GroupMemberRunStatus";

afterEach(cleanup);

const CONV = "conv-group";

interface RunSeed {
  id: string;
  agentId: string;
  status: RunStatus;
  conversationId?: string;
  startedAt?: string;
  lastActivityAt?: string;
}

function makeRun(seed: RunSeed): Run {
  const startedAt = seed.startedAt ?? "2026-10-07T00:00:00.000Z";
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

/** A client whose runs endpoint hands back the exact list (including foreign runs). */
function clientReturning(runs: Run[], onCall?: () => void): ApiClient {
  const base = createMockClient({ seed: 1 });
  return {
    ...base,
    runs: {
      ...base.runs,
      list: async () => {
        onCall?.();
        return { items: runs, nextCursor: null };
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

function renderStatus(client: ApiClient, agentId = "agent-a"): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<GroupMemberRunStatus conversationId={CONV} agentId={agentId} />, {
    wrapper: wrapperFor(client, queryClient),
  });
  return queryClient;
}

const pills = () => document.querySelectorAll('[data-slot="status-pill"]');

describe("GroupMemberRunStatus", () => {
  it("shows the member's latest run in the current conversation", async () => {
    renderStatus(
      clientReturning([
        makeRun({ id: "run-old", agentId: "agent-a", status: "running" }),
        makeRun({
          id: "run-new",
          agentId: "agent-a",
          status: "waiting_for_input",
          startedAt: "2026-10-07T01:00:00.000Z",
        }),
      ]),
    );

    expect(await screen.findByText(t("status.run.waiting"))).toBeDefined();
    expect(screen.queryByText(t("status.run.running"))).toBeNull();
  });

  it("reflects SSE run updates on the shared query cache", async () => {
    const queryClient = renderStatus(
      clientReturning([makeRun({ id: "run-1", agentId: "agent-a", status: "waiting_for_input" })]),
    );
    await screen.findByText(t("status.run.waiting"));

    applyEvent(queryClient, {
      type: EventType.CUSTOM,
      name: "juno.run.updated",
      value: makeRun({
        id: "run-1",
        agentId: "agent-a",
        status: "completed",
        lastActivityAt: "2026-10-07T02:00:00.000Z",
      }),
      metadata: { juno: { runId: "run-1", conversationId: CONV } },
    });
    expect(await screen.findByText(t("status.run.completed"))).toBeDefined();

    applyEvent(queryClient, {
      type: EventType.CUSTOM,
      name: "juno.run.updated",
      value: makeRun({ id: "run-1", agentId: "agent-a", status: "failed" }),
      metadata: { juno: { runId: "run-1", conversationId: CONV } },
    });
    expect(await screen.findByText(t("status.run.failed"))).toBeDefined();
    expect(screen.queryByText(t("status.run.completed"))).toBeNull();
  });

  it("ignores runs from another conversation or another member", async () => {
    const queryClient = renderStatus(
      clientReturning([
        makeRun({
          id: "run-other-room",
          agentId: "agent-a",
          status: "running",
          conversationId: "conv-other",
        }),
        makeRun({ id: "run-other-agent", agentId: "agent-b", status: "running" }),
      ]),
    );

    await waitFor(() =>
      expect(queryClient.getQueryState(["runs", { conversationId: CONV }])?.status).toBe("success"),
    );
    expect(pills().length).toBe(0);
  });

  it("renders no status when the member has no run (never a fabricated idle)", async () => {
    const queryClient = renderStatus(clientReturning([]));

    await waitFor(() =>
      expect(queryClient.getQueryState(["runs", { conversationId: CONV }])?.status).toBe("success"),
    );
    expect(pills().length).toBe(0);
  });

  it("shares one request across rows of the same conversation", async () => {
    let calls = 0;
    const client = clientReturning(
      [
        makeRun({ id: "run-a", agentId: "agent-a", status: "running" }),
        makeRun({ id: "run-b", agentId: "agent-b", status: "running" }),
      ],
      () => {
        calls += 1;
      },
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <>
        <GroupMemberRunStatus conversationId={CONV} agentId="agent-a" />
        <GroupMemberRunStatus conversationId={CONV} agentId="agent-b" />
      </>,
      { wrapper: wrapperFor(client, queryClient) },
    );

    expect(await screen.findAllByText(t("status.run.running"))).toHaveLength(2);
    expect(calls).toBe(1);
  });

  it("renders nothing without a client (previews, standalone view tests)", () => {
    render(<GroupMemberRunStatus conversationId={CONV} agentId="agent-a" />);
    expect(pills().length).toBe(0);
  });
});
