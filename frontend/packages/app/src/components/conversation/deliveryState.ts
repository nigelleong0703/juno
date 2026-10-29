import type { Run } from "@agent-desktop/client";
import { ACTIVE_RUN } from "../../lib/doingLine";
import type { FailedSend } from "../../data/outbox";

/**
 * What the agent-status pill above the composer says (web parity with iOS): a refused send (a real
 * error, with Retry and Delete), or the stream reconnecting while a run is active. A working agent
 * has no pill: the typing bubble in the transcript is the only working indicator.
 */
export type AgentStatus =
  | { kind: "failed"; tempId: string; reason: string }
  | { kind: "reconnecting" };

export interface AgentStatusInput {
  /** The conversation's runs (any status); other conversations' runs are ignored. */
  runs: readonly Run[];
  conversationId: string | undefined;
  failed: Readonly<Record<string, FailedSend>>;
  /** The live event stream is up. */
  connected: boolean;
}

/** The pill's state for this conversation, or null when nothing failed and the stream is fine. */
export function agentStatus(input: AgentStatusInput): AgentStatus | null {
  const failed = latestFailed(input);
  if (failed) return failed;
  return !input.connected && hasActiveRun(input) ? { kind: "reconnecting" } : null;
}

/** The newest refused send of this conversation; it stays until the owner retries or deletes it. */
function latestFailed(input: AgentStatusInput): AgentStatus | null {
  let newest: FailedSend | undefined;
  for (const entry of Object.values(input.failed)) {
    if (entry.conversationId === input.conversationId) newest = entry;
  }
  return newest ? { kind: "failed", tempId: newest.tempId, reason: newest.reason } : null;
}

function hasActiveRun(input: AgentStatusInput): boolean {
  return input.runs.some(
    (run) => run.conversationId === input.conversationId && run.parentRunId === undefined && ACTIVE_RUN.includes(run.status),
  );
}
