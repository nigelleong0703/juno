import type { Request, Run, Step } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import { activityTitle, stepLine, isFailedRunRow, progressText, runErrorText, runStatusText, stepExcerpt, visibleSteps } from "../stepLine";

const step = (over: Partial<Step>): Step =>
  ({
    id: "s", runId: "r", index: 0, kind: "browser", verb: "Executed", target: "browser.click",
    status: "completed", startedAt: "2026-10-16T10:00:00Z", durationMs: 1, ...over,
  }) as Step;
const run = (steps: Step[]): Run => ({ title: "hello", steps }) as unknown as Run;
const clicked = (status: Step["status"]) =>
  step({ status, output: { summary: 'Clicked "256GB Included" (e1) on tab t1' } });
const approval = { payload: { kind: "approval", action: "gmail_send_email", why: "x" } } as unknown as Request;

describe("runStatusText", () => {
  it("lets a pending request win over the steps", () => {
    expect(runStatusText(run([clicked("completed")]), approval)).toBe("Needs you — approval to gmail send email");
  });

  it("turns the latest readable step progressive while it runs, past tense when done", () => {
    expect(runStatusText(run([clicked("running")]), undefined)).toBe("Clicking 256GB Included…");
    expect(runStatusText(run([clicked("completed")]), undefined)).toBe("Clicked 256GB Included…");
  });

  it("skips internal steps, and falls back to Working… without ever showing the title", () => {
    const hidden = step({ target: "browser.snapshot", internal: true });
    expect(runStatusText(run([clicked("completed"), hidden]), undefined)).toBe("Clicked 256GB Included…");
    expect(runStatusText(run([hidden]), undefined)).toBe("Working…");
    expect(runStatusText(undefined, undefined)).toBe("Working…");
  });
});

const full = (over: Partial<Run>): Run =>
  ({ status: "completed", startedAt: "2026-10-16T10:00:00Z", steps: [], usage: { steps: 0 }, ...over }) as unknown as Run;

describe("Activity wording", () => {
  it("hides the steps the backend flags internal and words the rest, never the raw tool id", () => {
    const plumbing = ["tool_search", "todo_write"].map((target) => step({ id: target, verb: "Executed", target, kind: "mcp", internal: true }));
    const real = step({ id: "gh", verb: "Executed", target: "github_create_issue", kind: "mcp" });
    expect(visibleSteps([...plumbing, real]).map((entry) => entry.id)).toEqual(["gh"]);
    expect(stepLine(real)).toBe("Github create issue");
    // The client keeps no list of tool names: an unflagged step shows whatever it is called.
    expect(stepLine(step({ target: "tool_search" }))).toBe("Tool search");
  });

  it("titles the card with the run's own title, else the message that started it, never 'Task'", () => {
    expect(activityTitle("Book the flights", "hi")).toBe("Book the flights");
    expect(activityTitle("Task", "Find me a flat\nunder 2k")).toBe("Find me a flat");
    expect(activityTitle(undefined, "a".repeat(80))).toBe(`${"a".repeat(60)}…`);
    expect(activityTitle("Task", undefined)).toBeUndefined();
  });

  it("only a top-level failed or stopped run gets a row", () => {
    expect(isFailedRunRow(full({ status: "failed" }))).toBe(true);
    expect(isFailedRunRow(full({ status: "stopped" }))).toBe(true);
    expect(isFailedRunRow(full({ status: "completed" }))).toBe(false);
    expect(isFailedRunRow(full({ status: "failed", parentRunId: "p" }))).toBe(false);
    expect(isFailedRunRow(undefined)).toBe(false);
  });

  it("humanizes provider errors", () => {
    expect(runErrorText("provider error (402) {x}")).toMatch(/out of credit/);
    expect(runErrorText("bad (401)")).toMatch(/rejected the key/);
    expect(runErrorText("Request failed: {\"a\":1}\nmore")).toBe("Request failed");
  });
});

describe("visibleSteps / stepExcerpt", () => {
  it("hides bookkeeping tools and collapses a step that reads like the one before", () => {
    const fetch = step({ id: "a", verb: "Read", target: "example.com", output: { summary: "Title: Shop\nURL: https://example.com/x" } });
    const same = step({ id: "b", index: 1, verb: "Read", target: "example.com", output: { summary: "Title: Shop" } });
    const shot = step({ id: "c", index: 2, target: "computer.screenshot", internal: true });
    const task = step({ id: "d", index: 3, target: "task_update", internal: true });
    const click = step({ id: "e", index: 4, output: { summary: 'Clicked "Buy now" at (1, 2)' } });
    expect(visibleSteps([fetch, same, shot, task, click]).map((s) => s.id)).toEqual(["a", "e"]);
  });

  it("strips snapshot noise from the excerpt", () => {
    const s = step({ output: { summary: "Title: x\nURL: y\n- e12 [button] Add\nThe price is $10" } });
    expect(stepExcerpt(s)).toBe("The price is $10");
  });
});

describe("which computer a file or shell step ran on", () => {
  const call = (target: string, args: Record<string, unknown>) => step({ target, input: { summary: JSON.stringify(args) } as Step["input"] });

  it("names the Mac only when the step ran there; sandbox steps keep their wording", () => {
    expect(stepLine(call("shell.run", { command: "ls" }))).toBe("Ran ls");
    expect(stepLine(call("shell.run", { command: "ls", on: "sandbox" }))).toBe("Ran ls");
    expect(stepLine(call("shell.run", { command: "ls", on: "mac" }))).toBe("Ran ls on your Mac");
    expect(stepLine(call("files.edit", { path: "~/Juno/notes.md", on: "mac" }))).toBe("Edited notes.md on your Mac");
    expect(stepLine(call("files.read", { path: "/workspace/a.txt" }))).toBe("Read a.txt");
  });

  it("says which way a copy went", () => {
    expect(stepLine(call("computer_copy", { from: "sandbox", to: "mac", path: "/workspace/report.pdf" }))).toBe("Copied report.pdf from the sandbox to your Mac");
    expect(stepLine(call("computer_copy", { from: "mac", to: "sandbox", path: "~/Juno/report.pdf" }))).toBe("Copied report.pdf from your Mac to the sandbox");
  });
});

describe("progressText", () => {
  it("reads the server's raw newest-step line in the step list's words", () => {
    expect(progressText("Executed browser.click")).toBe("Clicking on the page");
    expect(progressText("Executed shell.run")).toBe("Running a command");
    expect(progressText("Searched for “fares”")).toBe("Searched for “fares”");
  });
});
