import type { ApiClient, Request } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../ClientProvider";
import { useResolveRequest } from "../mutations";

const at = "2026-10-29T00:00:00.000Z";

function approval(id: string, runId = "run-1"): Request {
  return {
    id,
    kind: "approval",
    status: "pending",
    title: id,
    summary: id,
    agentId: "agent-1",
    conversationId: "conv-1",
    runId,
    payload: { kind: "approval", action: "Run command", why: "test" },
    createdAt: at,
  };
}

function wrapper(client: ApiClient, qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={qc}>{children}</ClientProvider>
  );
}

function resolveClient(pending: Request[], resolved: Request) {
  const base = createMockClient({ seed: 1 });
  const list = vi.fn(async () => ({ items: pending, nextCursor: null }));
  const get = vi.fn(async () => resolved);
  const resolve = vi.fn(async () => resolved);
  const resumeRequest = vi.fn(async () => ({ runId: "run-1" }));
  const client: ApiClient = {
    ...base,
    requests: { ...base.requests, list, get, resolve },
    conversations: { ...base.conversations, resumeRequest },
  };
  return { client, list, get, resolve, resumeRequest };
}

describe("typed approval through the standard run entry", () => {
  it("resumes one pending interrupt and returns the authoritative request row", async () => {
    const request = approval("req-one");
    const resolved = { ...request, status: "approved" as const, resolvedAt: at };
    const fake = resolveClient([request], resolved);
    const qc = new QueryClient();
    qc.setQueryData(["request", request.id], request);
    const { result } = renderHook(() => useResolveRequest(), { wrapper: wrapper(fake.client, qc) });

    act(() => result.current.mutate({ id: request.id, decision: { action: "approve", scope: "once" } }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fake.resumeRequest).toHaveBeenCalledWith("conv-1", "req-one", { action: "approve", scope: "once" }, "run-1");
    expect(fake.resolve).not.toHaveBeenCalled();
    expect(result.current.data).toEqual(resolved);
  });

  it("keeps a single card usable when the segment has sibling interrupts by persisting this decision", async () => {
    const request = approval("req-one");
    const sibling = approval("req-two");
    const resolved = { ...request, status: "approved" as const, resolvedAt: at };
    const fake = resolveClient([request, sibling], resolved);
    const qc = new QueryClient();
    qc.setQueryData(["request", request.id], request);
    const { result } = renderHook(() => useResolveRequest(), { wrapper: wrapper(fake.client, qc) });

    act(() => result.current.mutate({ id: request.id, decision: { action: "approve", scope: "once" } }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fake.resolve).toHaveBeenCalledWith("req-one", { action: "approve", scope: "once" });
    expect(fake.resumeRequest).not.toHaveBeenCalled();
    expect(fake.list).toHaveBeenCalledWith({ status: "pending", limit: 200 });
  });

  it("uses the product decision route for a request that has no run to resume", async () => {
    const { runId: _runId, ...noRun } = approval("req-claim");
    const request: Request = noRun;
    const resolved = { ...request, status: "approved" as const, resolvedAt: at };
    const fake = resolveClient([request], resolved);
    const qc = new QueryClient();
    qc.setQueryData(["request", request.id], request);
    const { result } = renderHook(() => useResolveRequest(), { wrapper: wrapper(fake.client, qc) });

    act(() => result.current.mutate({ id: request.id, decision: { action: "approve", scope: "once" } }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fake.resolve).toHaveBeenCalledWith("req-claim", { action: "approve", scope: "once" });
    expect(fake.resumeRequest).not.toHaveBeenCalled();
  });
});
