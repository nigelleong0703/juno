import type { Agent, Run } from "@agent-desktop/client";

/** Statuses of a run the agent is still working on (or waiting on the user for). */
/** Runs the agent is actually on now (iPhone World+Runs `isWorking`): a blocked run waits on something else and is not "working". `waiting_for_input` stays: its pending request turns the pill into "Needs you". */
export const ACTIVE_RUN: Run["status"][] = ["running", "waiting_for_input", "queued"];

/** The newest top-level run (no parent) of an agent that matches `keep`, by `startedAt`. */
function newestTopLevelRun(
  runs: readonly Run[] | undefined,
  agentId: string,
  keep: (run: Run) => boolean = () => true,
): Run | undefined {
  let newest: Run | undefined;
  for (const run of runs ?? []) {
    if (run.agentId !== agentId || run.parentRunId !== undefined || !keep(run)) continue;
    if (newest === undefined || Date.parse(run.startedAt) > Date.parse(newest.startedAt)) newest = run;
  }
  return newest;
}

/**
 * The "what is it doing" line for an agent, shared by every surface that shows it (agent card, agent
 * pane, chat header). iPhone rule: a line only while the agent is working or needs the user (status
 * `working` / `needs_you`, or an active top-level run); then the live `doing`, the planned one-liner,
 * the active run's title. Otherwise `undefined` and the caller shows the status word (`agentStatusMeta`),
 * never a stale last task title.
 *
 * The line is always the agent's words, never the owner's: a run's title is the owner's raw message until the
 * agent names it (`titleGenerated`), so an unnamed title is not used, and a `doing` the server filled in from one
 * (it falls back to the raw title) is dropped.
 */
export function resolveDoingLine(input: {
  agentId: string;
  status?: Agent["status"];
  planned?: string;
  agentDoing?: string;
  runs?: readonly Run[];
}): string | undefined {
  const { agentId, status, planned, agentDoing, runs } = input;
  const activeRun = newestTopLevelRun(runs, agentId, (run) => ACTIVE_RUN.includes(run.status));
  if (!activeRun && status !== "working" && status !== "needs_you") return undefined;
  const said = new Set((runs ?? []).filter((run) => run.agentId === agentId && !run.titleGenerated).map((run) => run.title.trim()));
  const agentWords = (text: string | undefined) => (text !== undefined && text.trim() !== "" && !said.has(text.trim()) ? text : undefined);
  return agentWords(agentDoing) ?? agentWords(planned) ?? (activeRun?.titleGenerated ? agentWords(activeRun.title) : undefined);
}
