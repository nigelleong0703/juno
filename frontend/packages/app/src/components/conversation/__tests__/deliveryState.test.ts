import type { Run } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import type { FailedSend } from "../../../data/outbox";
import { agentStatus, type AgentStatusInput } from "../deliveryState";

function run(overrides: Partial<Run> & Pick<Run, "id" | "status" | "startedAt">): Run {
  return {
    agentId: "a1",
    conversationId: "c1",
    kind: "chat",
    title: "Task",
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    lastActivityAt: overrides.startedAt,
    ...overrides,
  };
}

function input(overrides: Partial<AgentStatusInput> = {}): AgentStatusInput {
  return { runs: [], conversationId: "c1", failed: {}, connected: true, ...overrides };
}

const failure = (tempId: string, conversationId = "c1"): Record<string, FailedSend> => ({
  [tempId]: {
    tempId,
    identity: { messageId: `msg-${tempId}`, runId: `run-${tempId}` },
    conversationId,
    payload: { text: "Book the flights" } as FailedSend["payload"],
    reason: "Network down",
    item: {} as FailedSend["item"],
  },
});

describe("agentStatus", () => {
  it("is failed for a refused send of this conversation only", () => {
    expect(agentStatus(input({ failed: failure("optimistic-9-9") }))).toEqual({
      kind: "failed",
      tempId: "optimistic-9-9",
      reason: "Network down",
    });
    expect(agentStatus(input({ failed: failure("optimistic-9-9", "other") }))).toBeNull();
  });

  it("never reports a working agent: an active run alone gives no pill", () => {
    const busy = run({ id: "r1", status: "running", startedAt: "2026-10-11T10:00:00.000Z" });
    expect(agentStatus(input({ runs: [busy] }))).toBeNull();
  });

  it("is reconnecting while a top-level run of this chat is active and the stream is down; a refused send still wins", () => {
    const active = run({ id: "r10", status: "running", startedAt: "2026-10-11T10:00:05.000Z" });
    const child = run({ id: "r11", status: "running", startedAt: "2026-10-11T10:00:06.000Z", parentRunId: "r10", conversationId: "c1" });
    const other = run({ id: "r12", status: "running", startedAt: "2026-10-11T10:00:07.000Z", conversationId: "c2" });
    expect(agentStatus(input({ runs: [active], connected: false }))).toEqual({ kind: "reconnecting" });
    expect(agentStatus(input({ runs: [child, other], connected: false }))).toBeNull();
    expect(agentStatus(input({ connected: false }))).toBeNull();
    expect(agentStatus(input({ runs: [active], connected: false, failed: failure("optimistic-9-9") }))).toEqual(
      expect.objectContaining({ kind: "failed" }),
    );
  });
});
