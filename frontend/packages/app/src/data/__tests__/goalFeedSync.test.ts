import type { AgentEvent, FeedPost, Goal, ListResult } from "@agent-desktop/client";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import type { FeedPages } from "../feed";
import { qk } from "../keys";
import { applyEvent } from "../liveSync";

let qc: QueryClient;

beforeEach(() => {
  qc = new QueryClient();
});

const post = (id: string, agentId = "agent-1"): FeedPost => ({
  id,
  agentId,
  title: `Post ${id}`,
  summary: "A short summary.",
  liked: false,
  createdAt: "2026-10-11T08:00:00.000Z",
  updatedAt: "2026-10-11T08:00:00.000Z",
});

const goal = (id: string, agentId = "agent-1"): Goal => ({
  id,
  agentId,
  kind: "goal",
  title: `Goal ${id}`,
  summary: "",
  status: "active",
  createdAt: "2026-10-11T08:00:00.000Z",
  updatedAt: "2026-10-11T08:00:00.000Z",
});

describe("feed and goal events in the cache", () => {
  it("prepends a new post to the first page of every matching feed list, and replaces it on update", () => {
    const first: ListResult<FeedPost> = { items: [post("p1")], nextCursor: "c1" };
    const older: ListResult<FeedPost> = { items: [post("p0")], nextCursor: null };
    const pages: FeedPages = { pages: [first, older], pageParams: [undefined, "c1"] };
    qc.setQueryData(qk.feed(), pages);
    qc.setQueryData(qk.feed({ agentId: "agent-2" }), { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] });

    applyEvent(qc, { type: "feed.created", post: post("p2") } as AgentEvent);
    const all = qc.getQueryData<FeedPages>(qk.feed());
    expect(all?.pages[0]?.items.map((entry) => entry.id)).toEqual(["p2", "p1"]);
    expect(all?.pages[1]?.items.map((entry) => entry.id)).toEqual(["p0"]);
    // A post for another agent does not join a filtered list.
    expect(qc.getQueryData<FeedPages>(qk.feed({ agentId: "agent-2" }))?.pages[0]?.items).toEqual([]);

    applyEvent(qc, { type: "feed.updated", post: { ...post("p1"), liked: true } } as AgentEvent);
    expect(qc.getQueryData<FeedPages>(qk.feed())?.pages[0]?.items[1]?.liked).toBe(true);
  });

  it("keeps the cached timeline when a goal update arrives without one, and drops deleted goals", () => {
    const timeline = [{ at: "2026-10-11T08:00:00.000Z", actor: "agent" as const, kind: "created" as const, text: "Started" }];
    qc.setQueryData<Goal>(qk.goal("g1"), { ...goal("g1"), activity: timeline });
    qc.setQueryData<Goal[]>(qk.goals({ agentId: "agent-1" }), [goal("g1")]);

    applyEvent(qc, { type: "goal.updated", goal: { ...goal("g1"), status: "done" } } as AgentEvent);
    expect(qc.getQueryData<Goal>(qk.goal("g1"))?.status).toBe("done");
    expect(qc.getQueryData<Goal>(qk.goal("g1"))?.activity).toEqual(timeline);
    expect(qc.getQueryData<Goal[]>(qk.goals({ agentId: "agent-1" }))?.[0]?.status).toBe("done");

    applyEvent(qc, { type: "goal.deleted", goalId: "g1" } as AgentEvent);
    expect(qc.getQueryData<Goal[]>(qk.goals({ agentId: "agent-1" }))).toEqual([]);
  });
});
