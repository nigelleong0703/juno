import type { AgentTask } from "@agent-desktop/client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { applyEvent } from "../../data/liveSync";
import { taskKeys } from "../../data/queryKeys";
import { appendEnded, type TaskPage } from "../../data/tasks";
import { buildTaskTree, entryIsLive, groupTaskEntries, taskNeedsYou, taskPhase, taskSubtitle } from "../taskView";

function task(over: Partial<AgentTask> & Pick<AgentTask, "id">): AgentTask {
  return {
    kind: "task",
    agentId: "agent-a",
    conversationId: "conv-a",
    rootRunId: "run-a",
    depth: 0,
    origin: { type: "owner_message", conversationId: "conv-a" },
    mode: "background",
    replyTo: { type: "none" },
    status: "running",
    title: over.id,
    startedAt: "2026-10-29T08:00:00.000Z",
    updatedAt: "2026-10-29T08:00:00.000Z",
    ...over,
  };
}

describe("task wording", () => {
  it("names every state the server can report", () => {
    const label = (over: Partial<AgentTask>) => taskPhase(task({ id: "t", ...over })).label;
    expect(label({ status: "queued" })).toBe("Queued");
    expect(label({ status: "running" })).toBe("Running");
    expect(label({ status: "waiting", waitingFor: "owner_input" })).toBe("Waiting for you");
    expect(label({ status: "waiting", waitingFor: "approval" })).toBe("Waiting for approval");
    expect(label({ status: "ended", outcome: "done" })).toBe("Done");
    expect(label({ status: "ended", outcome: "failed" })).toBe("Didn't finish");
    expect(label({ status: "ended", outcome: "cancelled" })).toBe("Stopped");
    expect(label({ status: "ended", outcome: "needs_input" })).toBe("Needs your input");
    expect(label({ status: "ended", outcome: "unknown_effect" })).toBe("Outcome unknown, check before retrying");
  });

  it("a failed task says why, then the agent's result line; a waiting one shows its question", () => {
    const failed = task({ id: "f", status: "ended", outcome: "failed", outcomeDetail: "timed_out", resultLine: "Exited with code 1" });
    expect(taskSubtitle(failed)).toBe("Timed out · Exited with code 1");
    expect(taskSubtitle(task({ id: "f2", status: "ended", outcome: "failed" }))).toBe("Didn't finish");
    expect(taskSubtitle(task({ id: "w", status: "waiting", waitingFor: "approval", progress: "Send the invoice to Priya?" }))).toBe("Waiting for approval · Send the invoice to Priya?");
    expect(taskSubtitle(task({ id: "q", status: "queued", outcomeDetail: "dispatch_failed" }))).toBe("Could not be started, will retry");
  });

  it("says who stopped a task: you, the agent by name, or the system on its own", () => {
    const stopped = (outcomeDetail: AgentTask["outcomeDetail"]) => task({ id: "s", status: "ended", outcome: "cancelled", ...(outcomeDetail ? { outcomeDetail } : {}) });
    expect(taskSubtitle(stopped("stopped_by_owner"))).toBe("Stopped by you");
    expect(taskSubtitle(stopped("stopped_by_agent"), "Juno")).toBe("Stopped by Juno");
    expect(taskSubtitle(stopped("stopped_by_agent"))).toBe("Stopped by the agent");
    expect(taskSubtitle(stopped("stopped_by_system"))).toBe("Stopped automatically");
    // Stopped before the server recorded who: just the pill's word.
    expect(taskSubtitle(stopped(undefined))).toBe("Stopped");
  });

  it("sends the person to the conversation only when the task needs them", () => {
    expect(taskNeedsYou(task({ id: "a", status: "waiting", waitingFor: "owner_input" }))).toEqual({ conversationId: "conv-a" });
    expect(taskNeedsYou(task({ id: "b", status: "waiting", waitingFor: "effect_review" }))).toEqual({ conversationId: "conv-a" });
    expect(taskNeedsYou(task({ id: "c", status: "ended", outcome: "unknown_effect", outcomeDetail: "effect_review" }))).toEqual({ conversationId: "conv-a" });
    expect(taskNeedsYou(task({ id: "d", status: "ended", outcome: "needs_input" }))).toEqual({ conversationId: "conv-a" });
    expect(taskNeedsYou(task({ id: "e", status: "waiting", waitingFor: "event" }))).toBeUndefined();
    expect(taskNeedsYou(task({ id: "f", status: "ended", outcome: "failed" }))).toBeUndefined();
    expect(taskNeedsYou(task({ id: "g", status: "waiting", waitingFor: "owner_input", conversationId: undefined }))).toBeUndefined();
  });
});

describe("task tree", () => {
  it("hangs children under the parent in the list; a task whose parent is missing is top-level", () => {
    const parent = task({ id: "sub", kind: "subagent", childRunId: "run-child", parentId: "run-a" });
    const viaId = task({ id: "cmd", kind: "command", parentId: "sub", depth: 1, startedAt: "2026-10-29T08:02:00.000Z" });
    const viaRun = task({ id: "conn", kind: "connector", parentId: "run-child", depth: 1, startedAt: "2026-10-29T08:01:00.000Z" });
    const tree = buildTaskTree([viaId, parent, viaRun]);
    expect(tree.map((node) => node.task.id)).toEqual(["sub"]);
    expect(tree[0]?.children.map((node) => node.task.id)).toEqual(["conn", "cmd"]);
  });

  it("keeps tasks that point at each other instead of losing them", () => {
    const tree = buildTaskTree([task({ id: "x", parentId: "y" }), task({ id: "y", parentId: "x" })]);
    expect(tree.map((node) => node.task.id).sort()).toEqual(["x", "y"]);
  });

  it("gathers routine runs under their routine and marks a group live while any run is", () => {
    const run = (id: string, over: Partial<AgentTask> = {}) =>
      task({ id, kind: "routine", routineId: "routine-a", runId: `run-${id}`, mode: "scheduled", origin: { type: "routine", routineId: "routine-a", occurrenceAt: "2026-10-29T08:00:00.000Z" }, ...over });
    const entries = groupTaskEntries([run("r1", { status: "ended", outcome: "done" }), task({ id: "plain" }), run("r2", { status: "ended", outcome: "failed" })]);
    expect(entries.map((entry) => entry.type)).toEqual(["routine", "task"]);
    const group = entries[0];
    expect(group?.type === "routine" && group.runs.map((node) => node.task.id)).toEqual(["r1", "r2"]);
    expect(entryIsLive(entries[0]!)).toBe(false);
    expect(entryIsLive(groupTaskEntries([run("r3")])[0]!)).toBe(true);
  });
});

describe("task.updated and paging", () => {
  it("upserts by id: a new task joins the front, a known one is replaced in place", () => {
    const qc = new QueryClient();
    const first = task({ id: "a" });
    qc.setQueryData<TaskPage>(taskKeys.agentTasks("agent-a"), { items: [first], nextCursor: "c1" });
    applyEvent(qc, { type: "task.updated", task: task({ id: "b" }) });
    applyEvent(qc, { type: "task.updated", task: { ...first, status: "ended", outcome: "done", resultLine: "Finished" } });
    const page = qc.getQueryData<TaskPage>(taskKeys.agentTasks("agent-a"));
    expect(page?.items.map((entry) => `${entry.id}:${entry.status}`)).toEqual(["b:running", "a:ended"]);
    expect(page?.nextCursor).toBe("c1");
  });

  it("appends an older page without duplicating a task an event already put in the list", () => {
    const old: TaskPage = { items: [task({ id: "a" })], nextCursor: "c1" };
    const next = appendEnded(old, { items: [task({ id: "a" }), task({ id: "z" })], nextCursor: null });
    expect(next?.items.map((entry) => entry.id)).toEqual(["a", "z"]);
    expect(next?.nextCursor).toBeNull();
  });
});
