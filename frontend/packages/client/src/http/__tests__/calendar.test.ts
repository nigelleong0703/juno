import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

const ITEM = {
  id: "cal-1",
  agentId: "agent-juno",
  ownerId: "owner-1",
  kind: "follow_up",
  title: "Check in with Sam",
  at: "2026-10-22T09:00:00.000Z",
  timezone: "UTC",
  instructions: "Ask how the move went",
  status: "scheduled",
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

function setup() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = init?.method === "GET" ? { items: [ITEM] } : ITEM;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = createHttpClient({ baseUrl: "http://api.test", getToken: () => "tok", fetch });
  return { calls, client };
}

describe("calendar api", () => {
  it("lists a range, optionally for one agent", async () => {
    const { calls, client } = setup();
    const result = await client.calendar.list({ from: "2026-10-19T00:00:00.000Z", to: "2026-10-26T00:00:00.000Z", agentId: "agent-juno" });
    expect(result.items).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/calendar");
    expect(url.searchParams.get("from")).toBe("2026-10-19T00:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-10-26T00:00:00.000Z");
    expect(url.searchParams.get("agentId")).toBe("agent-juno");
  });

  it("patches and cancels by id", async () => {
    const { calls, client } = setup();
    await client.calendar.update("cal-1", { at: "2026-10-23T09:00:00.000Z" });
    await client.calendar.cancel("cal-1");
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { at: "2026-10-23T09:00:00.000Z" } });
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v1/calendar/cal-1");
    expect(calls[1]?.method).toBe("DELETE");
    expect(new URL(calls[1]?.url ?? "").pathname).toBe("/v1/calendar/cal-1");
  });
});
