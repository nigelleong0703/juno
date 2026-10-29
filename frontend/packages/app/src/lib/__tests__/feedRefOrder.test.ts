import type { Item } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import { feedRefsAfterReply, runsWithFeedRef } from "../items";

const at = "2026-10-15T08:00:00.000Z";
const reply = (id: string, runId?: string) => ({ type: "agent_message", id, conversationId: "c", at, agentId: "a", runId, markdown: id, citations: [] }) as Item;
const ref = (id: string, runId?: string) => ({ type: "feed_ref", id, conversationId: "c", at, agentId: "a", runId, feedPostId: "p", title: "t" }) as Item;

describe("feedRefsAfterReply", () => {
  it("moves the card behind the last reply of its run", () => {
    const items = [reply("lead", "r1"), ref("card", "r1"), reply("final", "r1"), reply("other", "r2")];
    expect(feedRefsAfterReply(items).map((i) => i.id)).toEqual(["lead", "final", "card", "other"]);
  });
  it("keeps the card when no later reply exists or the run is unknown", () => {
    const items = [reply("lead", "r1"), ref("card", "r1"), ref("loose")];
    expect(feedRefsAfterReply(items)).toBe(items);
  });
  it("lists the runs that posted", () => {
    expect([...runsWithFeedRef([reply("a", "r1"), ref("c", "r1"), ref("d")])]).toEqual(["r1"]);
  });
});
