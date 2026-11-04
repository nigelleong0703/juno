import type { Agent, Run } from "@agent-desktop/client";
import { Button, Skeleton, cn } from "@agent-desktop/ui";
import { ExternalLink, Square } from "lucide-react";
import { canStopRun, useSubagentResult, useSubagentRuns } from "../../data/subagent-runs";
import { t } from "../../lib/i18n";
import { RunStatusPill } from "./RunStatusPill";

export interface SubagentRunsProps {
  parentRunId: string;
  conversationId: string;
  agentById?: (id: string) => Agent | undefined;
  onOpenRun?: (runId: string) => void;
  onStopRun?: (runId: string) => void;
  className?: string;
}

/**
 * Subagents of one parent run in the original chat. Rows link the exact subagent run id with its
 * truthful status, target agent and own canonical result; opening reuses the existing run
 * thread and stopping cancels the actual subagent run. A subagent is a work item: its result renders
 * on the card only and never becomes a chat bubble in this conversation.
 */
export function SubagentRuns({ parentRunId, conversationId, agentById, onOpenRun, onStopRun, className }: SubagentRunsProps) {
  const { subagents, isLoading, isError, refetch } = useSubagentRuns(parentRunId, conversationId);
  if (isLoading) {
    return (
      <ul className={cn("flex flex-col gap-1 py-1 pl-5", className)} aria-label={t("run.subagentTask")}>
        <li><Skeleton className="h-12 w-full rounded-[10px]" /></li>
        <li><Skeleton className="h-12 w-full rounded-[10px]" /></li>
      </ul>
    );
  }
  if (isError) {
    return (
      <div className={cn("flex items-center gap-2 py-1 pl-5 text-sm", className)}>
        <span className="text-danger">{t("common.error")}</span>
        <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={refetch}>{t("common.retry")}</Button>
      </div>
    );
  }
  if (subagents.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1 py-1 pl-5", className)} aria-label={t("run.subagentTask")}>
      {subagents.map((subagent) => (
        <SubagentRunRow
          key={subagent.id}
          subagent={subagent}
          parentRunId={parentRunId}
          conversationId={conversationId}
          agentName={agentById?.(subagent.agentId)?.name ?? subagent.agentId}
          onOpenRun={onOpenRun}
          onStopRun={onStopRun}
        />
      ))}
    </ul>
  );
}

function SubagentRunRow({ subagent, parentRunId, conversationId, agentName, onOpenRun, onStopRun }: {
  subagent: Run;
  parentRunId: string;
  conversationId: string;
  agentName: string;
  onOpenRun?: (runId: string) => void;
  onStopRun?: (runId: string) => void;
}) {
  const { result, isLoading, isError, refused, refetch } = useSubagentResult(parentRunId, conversationId, subagent.id, subagent.agentId, subagent.id);
  const stoppable = canStopRun(subagent.status);
  return (
    <li
      className="flex flex-col gap-1 rounded-[10px] border border-border bg-surface px-2.5 py-2"
      data-testid={"subagent-run-" + subagent.id}
    >
      <div className="flex min-w-0 items-center gap-2">
        <RunStatusPill status={subagent.status} />
        <span className="shrink-0 text-xs font-medium text-fg-muted">{t("run.subagentTask")}</span>
        <span className="truncate text-sm font-medium text-fg">{subagent.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {stoppable && onStopRun && (
            <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => onStopRun(subagent.id)} aria-label={t("run.stop") + " " + subagent.id}>
              <Square className="size-3" />
            </Button>
          )}
          {onOpenRun && (
            <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => onOpenRun(subagent.id)} aria-label={t("chat.thread.open") + " " + subagent.id}>
              <ExternalLink className="size-3" />
            </Button>
          )}
        </span>
      </div>
      <div className="truncate text-xs text-fg-muted">{agentName + " · " + subagent.id}</div>
      {result && <p className="line-clamp-3 text-sm text-fg">{result}</p>}
      {!refused && !result && isLoading && <Skeleton className="h-4 w-40" />}
      {!refused && !result && isError && <p className="text-xs text-danger">{t("common.error")}</p>}
      {!refused && !result && !isLoading && !isError && !stoppable && (
        <Button variant="ghost" size="sm" className="h-6 self-start px-1.5" onClick={refetch}>{t("common.retry")}</Button>
      )}
    </li>
  );
}
