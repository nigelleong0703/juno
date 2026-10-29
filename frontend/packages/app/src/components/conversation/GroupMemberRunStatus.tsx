import type { Run } from "@agent-desktop/client";
import { useContext } from "react";
import { ClientContext } from "../../data/ClientProvider";
import { useRuns } from "../../data/queries";
import { RunStatusPill } from "../run/RunStatusPill";

export interface GroupMemberRunStatusProps {
  /** The conversation whose members popover is asking for this row's status. */
  conversationId: string;
  /** The workspace agent this member row belongs to. */
  agentId: string;
}

/**
 * Latest real Run for one group member inside the CURRENT conversation, rendered in
 * the existing members popover row (owner ask 2026-10-08: group collaboration must be
 * observable). The runs list is not reliably conversation-scoped — liveSync upserts
 * every run — so both ids are filtered explicitly here: another room's or another
 * member's run never leaks into this row. A member with no known run renders nothing;
 * an absent run is unknown, never a fabricated idle.
 */
export function GroupMemberRunStatus({ conversationId, agentId }: GroupMemberRunStatusProps) {
  // Preview and standalone view tests mount the members popover without a client;
  // there is nothing to query there, so render nothing instead of throwing.
  const bundle = useContext(ClientContext);
  if (!bundle) return null;
  return <GroupMemberRunStatusQuery conversationId={conversationId} agentId={agentId} />;
}

function GroupMemberRunStatusQuery({ conversationId, agentId }: GroupMemberRunStatusProps) {
  const { data: runs } = useRuns({ conversationId });
  const latest = latestRunFor(runs, conversationId, agentId);
  if (!latest) return null;
  return <RunStatusPill status={latest.status} />;
}

/** Newest run for one agent in one conversation, by real activity then start time. */
function latestRunFor(runs: Run[] | undefined, conversationId: string, agentId: string): Run | undefined {
  let latest: Run | undefined;
  for (const run of runs ?? []) {
    if (run.conversationId !== conversationId || run.agentId !== agentId) continue;
    if (!latest || runRecency(run) >= runRecency(latest)) latest = run;
  }
  return latest;
}

/** Milliseconds of the most recent real timestamp a run carries. */
function runRecency(run: Run): number {
  const started = Date.parse(run.startedAt);
  const activity = Date.parse(run.lastActivityAt);
  if (Number.isNaN(started)) return Number.isNaN(activity) ? 0 : activity;
  if (Number.isNaN(activity)) return started;
  return Math.max(started, activity);
}
