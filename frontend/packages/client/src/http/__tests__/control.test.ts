import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

const SCREEN = {
  id: "screen-a",
  agentId: "agent-a",
  displayNo: 1,
  state: "live",
  controller: "user",
  title: "Browser",
  ownerId: "owner-a",
  computerId: "computer-a",
  controlEpoch: 4,
  resolution: "1364x1024",
  lastUsedAt: "2026-10-29T00:00:00.000Z",
};

function clientReturning(payload: unknown) {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }));
  return { client: createHttpClient({ baseUrl: "http://api.test", getToken: () => "tok", fetch }), fetch };
}

const headersOf = (fetch: ReturnType<typeof clientReturning>["fetch"]) => (fetch.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;

describe("control gateway calls", () => {
  it("sends the epoch the person saw on take-over and return, and reads the new one back", async () => {
    const taken = clientReturning(SCREEN);
    const screen = await taken.client.computers.takeOverScreen("screen-a", { expectEpoch: 3 });
    expect(screen.controlEpoch).toBe(4);
    expect(headersOf(taken.fetch)["x-expect-epoch"]).toBe("3");
    expect(new URL(String(taken.fetch.mock.calls[0]?.[0])).pathname).toBe("/v1/screens/screen-a/take-over");

    const returned = clientReturning({ ...SCREEN, controller: "agent", controlEpoch: 5 });
    await returned.client.computers.returnControlScreen("screen-a", { expectEpoch: 4 });
    expect(headersOf(returned.fetch)["x-expect-epoch"]).toBe("4");
  });

  it("sends no epoch header when the caller has none, and Stop posts to the Mac's stop route", async () => {
    const plain = clientReturning(SCREEN);
    await plain.client.computers.takeOverScreen("screen-a");
    expect(headersOf(plain.fetch)["x-expect-epoch"]).toBeUndefined();

    const stopped = clientReturning({ paired: true, online: true, stopped: { since: "2026-10-29T00:00:00.000Z", epoch: 2 } });
    const status = await stopped.client.computers.stopMyMac();
    expect(status.stopped?.epoch).toBe(2);
    expect(stopped.fetch.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(new URL(String(stopped.fetch.mock.calls[0]?.[0])).pathname).toBe("/v1/computers/my-mac/stop");
  });
});

describe("apps.reviewTools", () => {
  it("marks tools reviewed with the tools given, or all of them", async () => {
    const some = clientReturning({ reviewed: ["create_draft"] });
    expect(await some.client.apps.reviewTools("gmail", { tools: ["create_draft"] })).toEqual({ reviewed: ["create_draft"] });
    expect(JSON.parse(String(some.fetch.mock.calls[0]?.[1]?.body))).toEqual({ tools: ["create_draft"] });
    expect(new URL(String(some.fetch.mock.calls[0]?.[0])).pathname).toBe("/v1/apps/gmail/tools/review");
  });
});
