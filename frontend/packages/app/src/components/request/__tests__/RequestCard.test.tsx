import type { Request } from "@agent-desktop/client";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { qk } from "../../../data/keys";
import { useResolveRequest } from "../../../data/mutations";
import type { ApiClient } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { RequestCard } from "../RequestCard";

const ISO = "2026-10-06T00:00:00.000Z";

function questionRequest(status: Request["status"] = "pending"): Request {
  return {
    id: "req-qf1",
    kind: "question",
    status,
    title: "Which baseline?",
    summary: "Pick one.",
    agentId: "agent-juno",
    conversationId: "conv-juno",
    createdAt: ISO,
    resolvedAt: status === "pending" ? undefined : ISO,
    payload: {
      kind: "question",
      ui: {
        version: 1,
        blocks: [{ type: "fields", id: "form", fields: [{ id: "q-note", label: "Anything to weigh in?", kind: "text", placeholder: "Your answer\u2026" }] }],
      },
    },
  };
}

function answeredQuestion(): Request {
  const request = questionRequest("answered");
  if (request.payload.kind !== "question") throw new Error("fixture must be a question");
  return {
    ...request,
    decision: { by: "member-robin", at: ISO, mode: "manual", scope: "once" },
    payload: { ...request.payload, answers: { "q-note": "Latency first" } },
  };
}

function failingClient(): { client: ApiClient; seen: string[] } {
  const seen: string[] = [];
  const base = createMockClient({ seed: 3 });
  const requests = {
    ...base.requests,
    resolve: async () => {
      seen.push("resolve");
      throw new Error("transport down");
    },
  };
  return { client: { ...base, requests }, seen };
}

afterEach(cleanup);

describe("owner-claim question", () => {
  it("reads as a title, facts and two choices", () => {
    const base = questionRequest();
    if (base.payload.kind !== "question") throw new Error("fixture must be a question");
    const request: Request = {
      ...base,
      title: "Is this you? Telegram user Ann messaged @JunoBot",
      payload: {
        ...base.payload,
        ui: {
          version: 1,
          title: "Is this you? Telegram user Ann messaged @JunoBot",
          blocks: [
            { type: "facts", rows: [{ label: "Platform", value: "Telegram" }, { label: "From", value: "Ann" }, { label: "Message", value: "hi there" }] },
            { type: "choices", id: "claim", options: [{ id: "me", label: "It's me", style: "primary" }, { id: "not", label: "Not me" }] },
          ],
        },
      },
    };
    render(<RequestCard request={request} onResolve={() => undefined} />);
    expect(screen.getByText(/Is this you\? Telegram user Ann/)).toBeDefined();
    expect(screen.getByText("Ann")).toBeDefined();
    expect(screen.getByRole("radio", { name: "It's me" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Not me" })).toBeDefined();
  });
});

describe("RequestCard submission feedback", () => {
  it("keeps the answer form mounted and disabled while submitting, with a visible status", () => {
    const noop = () => {};
    const { rerender } = render(<RequestCard request={questionRequest()} onResolve={noop} />);
    const input = screen.getByPlaceholderText("Your answer\u2026");
    fireEvent.change(input, { target: { value: "Latency first" } });
    rerender(<RequestCard request={questionRequest()} submitting onResolve={noop} />);
    expect(screen.getByRole("status").textContent).toMatch(/Sending/u);
    expect(screen.getByPlaceholderText("Your answer\u2026")).toHaveProperty("value", "Latency first");
    expect(screen.getByRole("button", { name: "Submit" })).toHaveProperty("disabled", true);
  });

  it("a decided request is one slim row that expands in place to the full card with its answer", () => {
    render(<RequestCard request={answeredQuestion()} />);
    const row = screen.getByRole("button", { name: /Answered/u });
    expect(row.textContent).toMatch(/Latency first/u);
    expect(screen.queryByPlaceholderText("Your answer\u2026")).toBeNull();
    fireEvent.click(row);
    expect(screen.getByPlaceholderText("Your answer\u2026")).toHaveProperty("value", "Latency first");
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  it("disables retry while a retry is in flight and keeps the typed draft after an error", () => {
    const onRetry = vi.fn();
    const onResolve = vi.fn();
    const { rerender } = render(<RequestCard request={questionRequest()} onResolve={onResolve} />);
    fireEvent.change(screen.getByPlaceholderText("Your answer\u2026"), { target: { value: "Latency first" } });
    rerender(
      <RequestCard
        request={questionRequest()}
        submitting
        submitError={new Error("transport down")}
        onRetry={onRetry}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByRole("status").textContent).toMatch(/Sending/u);
    expect(screen.getByRole("alert").textContent).toMatch(/Could not send/u);
    expect(screen.getByRole("button", { name: "Try again" })).toHaveProperty("disabled", true);
    expect(screen.getByPlaceholderText("Your answer\u2026")).toHaveProperty("value", "Latency first");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(0);
  });

  it("an Allow the server refused as expired says Expired and offers no retry (the card is closing as timed out)", () => {
    const expired = Object.assign(new Error("The approval expired"), { status: 409, code: "REQUEST_EXPIRED" });
    render(<RequestCard request={questionRequest()} submitError={expired} onRetry={vi.fn()} onResolve={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe("Expired");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});

describe("useResolveRequest cache", () => {
  it("leaves detail pending on failure and revalidates it, then merges the authoritative answer on retry", async () => {
    const created = failingClient();
    const base = created.client;
    let fail = true;
    const resolve = async (id: string, decision: Parameters<ApiClient["requests"]["resolve"]>[1]) => {
      if (fail) return base.requests.resolve(id, decision);
      return {
        ...questionRequest("answered"),
        decision: { by: "member-robin", at: ISO, mode: "manual" as const, scope: "once" as const },
        payload: { ...answeredQuestion().payload, answers: { "q-note": "Latency first" } },
      };
    };
    const client = { ...base, requests: { ...base.requests, resolve } };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(qk.request("req-qf1"), questionRequest());
    queryClient.setQueryData(qk.requests({ status: "pending" }), [questionRequest()]);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ClientProvider client={client} queryClient={queryClient}>{children}</ClientProvider>
    );
    const { result } = renderHook(() => useResolveRequest(), { wrapper });
    await act(async () => {
      result.current.mutate({ id: "req-qf1", decision: { action: "answer", answers: { "q-note": "Latency first" } } });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const detail = queryClient.getQueryData<Request>(qk.request("req-qf1"));
    expect(detail?.status).toBe("pending");
    expect(created.seen).toContain("resolve");
    fail = false;
    await act(async () => {
      result.current.mutate({ id: "req-qf1", decision: { action: "answer", answers: { "q-note": "Latency first" } } });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const merged = queryClient.getQueryData<Request>(qk.request("req-qf1"));
    expect(merged?.status).toBe("answered");
    if (merged?.payload.kind !== "question") throw new Error("merged request must stay a question");
    expect(merged.payload.answers?.["q-note"]).toBe("Latency first");
    const pendingList = queryClient.getQueryData<Request[]>(qk.requests({ status: "pending" }));
    expect((pendingList ?? []).some((entry) => entry.id === "req-qf1")).toBe(false);
  });
});
