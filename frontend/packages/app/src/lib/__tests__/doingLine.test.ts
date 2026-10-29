import type { Run } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import { resolveDoingLine } from "../doingLine";

function run(overrides: Partial<Run> & Pick<Run, "id" | "status" | "title" | "startedAt">): Run {
  return {
    agentId: "a1",
    conversationId: "c1",
    kind: "chat",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    lastActivityAt: overrides.startedAt,
    ...overrides,
  };
}

describe("resolveDoingLine", () => {
  it("prefers the live doing, then the planned line, then the active run, while working", () => {
    const runs = [run({ id: "r1", status: "running", title: "Active task", titleGenerated: true, startedAt: "2026-10-11T10:00:00Z" })];
    expect(resolveDoingLine({ agentId: "a1", status: "working", planned: "Planned", agentDoing: "Doing", runs })).toBe("Doing");
    expect(resolveDoingLine({ agentId: "a1", status: "working", planned: "Planned", runs })).toBe("Planned");
    expect(resolveDoingLine({ agentId: "a1", status: "working", runs })).toBe("Active task");
  });

  it("shows nothing for an idle agent, even with a stale doing or a finished run (iPhone rule)", () => {
    const runs = [run({ id: "r1", status: "completed", title: "Latest finished", startedAt: "2026-10-11T10:00:00Z" })];
    expect(resolveDoingLine({ agentId: "a1", status: "idle", agentDoing: "Stale", planned: "Planned", runs })).toBeUndefined();
    expect(resolveDoingLine({ agentId: "a1", status: "sleeping", runs })).toBeUndefined();
  });

  it("shows a line when the user is needed, or a run is active whatever the status", () => {
    expect(resolveDoingLine({ agentId: "a1", status: "needs_you", agentDoing: "Waiting on approval" })).toBe("Waiting on approval");
    const runs = [run({ id: "r1", status: "waiting_for_input", title: "Needs input", titleGenerated: true, startedAt: "2026-10-11T10:00:00Z" })];
    expect(resolveDoingLine({ agentId: "a1", status: "idle", runs })).toBe("Needs input");
  });

  it("uses the newest active top-level run and ignores child runs", () => {
    const runs = [
      run({ id: "r1", status: "running", title: "Older", titleGenerated: true, startedAt: "2026-10-11T10:00:00Z" }),
      run({ id: "r2", status: "running", title: "Newer active", titleGenerated: true, startedAt: "2026-10-11T11:00:00Z" }),
      run({ id: "r3", status: "running", title: "Child", titleGenerated: true, startedAt: "2026-10-11T12:00:00Z", parentRunId: "r2" }),
    ];
    expect(resolveDoingLine({ agentId: "a1", runs })).toBe("Newer active");
    expect(resolveDoingLine({ agentId: "a1", runs: [runs[2]!] })).toBeUndefined();
  });

  it("never echoes the owner's message: an unnamed run title is not a doing line, and a doing that repeats one is dropped", () => {
    const said = run({ id: "r1", status: "running", title: "? Any other tool?", startedAt: "2026-10-11T10:00:00Z" });
    expect(resolveDoingLine({ agentId: "a1", status: "working", runs: [said] })).toBeUndefined();
    expect(resolveDoingLine({ agentId: "a1", status: "working", agentDoing: "? Any other tool?", runs: [said] })).toBeUndefined();
    expect(resolveDoingLine({ agentId: "a1", status: "working", agentDoing: "Searching the tool list", runs: [said] })).toBe("Searching the tool list");
    expect(resolveDoingLine({ agentId: "a1", status: "working", runs: [{ ...said, titleGenerated: true }] })).toBe("? Any other tool?");
  });
});
