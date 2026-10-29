import type { Run, RunStatus } from "@agent-desktop/client";
import { useMemo } from "react";
import { useRun, useRuns } from "./queries";

/**
 * Child-run reads for the original chat (PH12 visible, CT canonical result).
 *
 * Children filter from the canonical paged runs cache by the exact stored parent link —
 * never by agent heuristics or the latest reply. A child result is the canonical
 * Run.childResult on that exact run, matched by run id, agent, conversation and parent link;
 * the live run.updated stream keeps the cache current and refetch reloads through the run API.
 * Children are work items: their result never falls back to a chat bubble in this conversation.
 */

/** The children of one parent run in one conversation, from the canonical live runs cache. */
export function childRunsOf(runs: Run[], parentRunId: string, conversationId?: string): Run[] {
  if (conversationId === undefined) {
    return runs.filter((run) => run.parentRunId === parentRunId);
  }
  return runs.filter((run) => run.parentRunId === parentRunId && run.conversationId === conversationId);
}

/** The canonical child result of one run; null while the run carries none. */
export function childResultOf(run: Run | undefined): string | null {
  return run?.childResult ?? null;
}

/**
 * Scope guard: a result may be attributed only to the exact child — the exact run id, agent,
 * conversation and parent link. A missing conversation also refuses. Any mismatch refuses the
 * result instead of guessing.
 */
export function childScopeOk(parentRunId: string, conversationId: string, childRunId: string, childAgentId: string, run: Run): boolean {
  return (
    run.id === childRunId &&
    run.parentRunId === parentRunId &&
    run.agentId === childAgentId &&
    run.conversationId === conversationId
  );
}

/** running, queued and waiting_for_input are live work a stop request can still cancel. */
export function canStopRun(status: RunStatus): boolean {
  return status === "running" || status === "queued" || status === "waiting_for_input";
}

/** The children of one parent run from the canonical live runs cache. */
export function useChildRuns(parentRunId: string, conversationId?: string): { children: Run[]; isLoading: boolean; isError: boolean; refetch: () => void } {
  const { data, isLoading, isError, refetch } = useRuns();
  const children = useMemo(() => childRunsOf(data ?? [], parentRunId, conversationId), [data, parentRunId, conversationId]);
  return { children, isLoading, isError, refetch: () => { void refetch(); } };
}

export interface ChildResultState {
  result: string | null;
  isLoading: boolean;
  isError: boolean;
  /** True when the canonical run does not match the exact child scope; the result is refused. */
  refused: boolean;
  refetch: () => void;
}

/**
 * One child own result, read from canonical Run.childResult. The canonical single-run cache
 * (qk.run, fed by client.runs.get and kept current by the live run.updated stream) is the
 * source; there is no conversation-item fallback for new children.
 */
export function useChildResult(parentRunId: string, conversationId: string, childRunId: string, childAgentId: string, expectedChildRunId?: string): ChildResultState {
  const single = useRun(childRunId);
  const run = single.data;
  const refused = run !== undefined && !childScopeOk(parentRunId, conversationId, expectedChildRunId ?? childRunId, childAgentId, run);
  if (refused) {
    return { result: null, isLoading: false, isError: false, refused: true, refetch: () => {} };
  }
  return {
    result: childResultOf(run),
    isLoading: single.isLoading,
    isError: single.isError,
    refused: false,
    refetch: () => { void single.refetch(); },
  };
}
