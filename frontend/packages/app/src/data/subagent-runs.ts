import type { Run, RunStatus } from "@agent-desktop/client";
import { useMemo } from "react";
import { useRun, useRuns } from "./queries";

/**
 * Subagent-run reads for the original chat (PH12 visible, CT canonical result).
 *
 * Subagents filter from the canonical paged runs cache by the exact stored parent link —
 * never by agent heuristics or the latest reply. A subagent result is the canonical
 * Run.childResult on that exact run (the wire field keeps its name), matched by run id, agent,
 * conversation and parent link; the live run.updated stream keeps the cache current and refetch
 * reloads through the run API. Subagents are work items: their result never falls back to a chat
 * bubble in this conversation.
 */

/** The subagent runs of one parent run in one conversation, from the canonical live runs cache. */
export function subagentRunsOf(runs: Run[], parentRunId: string, conversationId?: string): Run[] {
  if (conversationId === undefined) {
    return runs.filter((run) => run.parentRunId === parentRunId);
  }
  return runs.filter((run) => run.parentRunId === parentRunId && run.conversationId === conversationId);
}

/** The canonical result of one subagent run; null while the run carries none. */
export function subagentResultOf(run: Run | undefined): string | null {
  return run?.childResult ?? null;
}

/**
 * Scope guard: a result may be attributed only to the exact subagent — the exact run id, agent,
 * conversation and parent link. A missing conversation also refuses. Any mismatch refuses the
 * result instead of guessing.
 */
export function subagentScopeOk(parentRunId: string, conversationId: string, subagentRunId: string, subagentAgentId: string, run: Run): boolean {
  return (
    run.id === subagentRunId &&
    run.parentRunId === parentRunId &&
    run.agentId === subagentAgentId &&
    run.conversationId === conversationId
  );
}

/** running, queued and waiting_for_input are live work a stop request can still cancel. */
export function canStopRun(status: RunStatus): boolean {
  return status === "running" || status === "queued" || status === "waiting_for_input";
}

/** The subagent runs of one parent run from the canonical live runs cache. */
export function useSubagentRuns(parentRunId: string, conversationId?: string): { subagents: Run[]; isLoading: boolean; isError: boolean; refetch: () => void } {
  const { data, isLoading, isError, refetch } = useRuns();
  const subagents = useMemo(() => subagentRunsOf(data ?? [], parentRunId, conversationId), [data, parentRunId, conversationId]);
  return { subagents, isLoading, isError, refetch: () => { void refetch(); } };
}

export interface SubagentResultState {
  result: string | null;
  isLoading: boolean;
  isError: boolean;
  /** True when the canonical run does not match the exact subagent scope; the result is refused. */
  refused: boolean;
  refetch: () => void;
}

/**
 * One subagent's own result, read from canonical Run.childResult. The canonical single-run cache
 * (qk.run, fed by client.runs.get and kept current by the live run.updated stream) is the
 * source; there is no conversation-item fallback for new subagents.
 */
export function useSubagentResult(parentRunId: string, conversationId: string, subagentRunId: string, subagentAgentId: string, expectedSubagentRunId?: string): SubagentResultState {
  const single = useRun(subagentRunId);
  const run = single.data;
  const refused = run !== undefined && !subagentScopeOk(parentRunId, conversationId, expectedSubagentRunId ?? subagentRunId, subagentAgentId, run);
  if (refused) {
    return { result: null, isLoading: false, isError: false, refused: true, refetch: () => {} };
  }
  return {
    result: subagentResultOf(run),
    isLoading: single.isLoading,
    isError: single.isError,
    refused: false,
    refetch: () => { void single.refetch(); },
  };
}
