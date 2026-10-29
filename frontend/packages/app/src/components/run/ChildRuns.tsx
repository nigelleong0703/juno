import type { Agent, Run } from "@agent-desktop/client";
import { Button, Skeleton, cn } from "@agent-desktop/ui";
import { ExternalLink, Square } from "lucide-react";
import { canStopRun, useChildResult, useChildRuns } from "../../data/child-runs";
import { t } from "../../lib/i18n";
import { RunStatusPill } from "./RunStatusPill";

export interface ChildRunsProps {
  parentRunId: string;
  conversationId: string;
  agentById?: (id: string) => Agent | undefined;
  onOpenRun?: (runId: string) => void;
  onStopRun?: (runId: string) => void;
  className?: string;
}

/**
 * Children of one parent run in the original chat. Rows link the exact child run id with its
 * truthful status, target agent and own canonical result; opening reuses the existing run
 * thread and stopping cancels the actual child run. A child is a work item: its result renders
 * on the card only and never becomes a chat bubble in this conversation.
 */
export function ChildRuns({ parentRunId, conversationId, agentById, onOpenRun, onStopRun, className }: ChildRunsProps) {
  const { children, isLoading, isError, refetch } = useChildRuns(parentRunId, conversationId);
  if (isLoading) {
    return (
      <ul className={cn("flex flex-col gap-1 py-1 pl-5", className)} aria-label={t("run.childTask")}>
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
  if (children.length === 0) return null;
  return (
    <ul className={cn("flex flex-col gap-1 py-1 pl-5", className)} aria-label={t("run.childTask")}>
      {children.map((child) => (
        <ChildRunRow
          key={child.id}
          child={child}
          parentRunId={parentRunId}
          conversationId={conversationId}
          agentName={agentById?.(child.agentId)?.name ?? child.agentId}
          onOpenRun={onOpenRun}
          onStopRun={onStopRun}
        />
      ))}
    </ul>
  );
}

function ChildRunRow({ child, parentRunId, conversationId, agentName, onOpenRun, onStopRun }: {
  child: Run;
  parentRunId: string;
  conversationId: string;
  agentName: string;
  onOpenRun?: (runId: string) => void;
  onStopRun?: (runId: string) => void;
}) {
  const { result, isLoading, isError, refused, refetch } = useChildResult(parentRunId, conversationId, child.id, child.agentId, child.id);
  const stoppable = canStopRun(child.status);
  return (
    <li
      className="flex flex-col gap-1 rounded-[10px] border border-border bg-surface px-2.5 py-2"
      data-testid={"child-run-" + child.id}
    >
      <div className="flex min-w-0 items-center gap-2">
        <RunStatusPill status={child.status} />
        <span className="shrink-0 text-xs font-medium text-fg-muted">{t("run.childTask")}</span>
        <span className="truncate text-sm font-medium text-fg">{child.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {stoppable && onStopRun && (
            <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => onStopRun(child.id)} aria-label={t("run.stop") + " " + child.id}>
              <Square className="size-3" />
            </Button>
          )}
          {onOpenRun && (
            <Button variant="ghost" size="sm" className="h-6 px-1.5" onClick={() => onOpenRun(child.id)} aria-label={t("chat.thread.open") + " " + child.id}>
              <ExternalLink className="size-3" />
            </Button>
          )}
        </span>
      </div>
      <div className="truncate text-xs text-fg-muted">{agentName + " · " + child.id}</div>
      {result && <p className="line-clamp-3 text-sm text-fg">{result}</p>}
      {!refused && !result && isLoading && <Skeleton className="h-4 w-40" />}
      {!refused && !result && isError && <p className="text-xs text-danger">{t("common.error")}</p>}
      {!refused && !result && !isLoading && !isError && !stoppable && (
        <Button variant="ghost" size="sm" className="h-6 self-start px-1.5" onClick={refetch}>{t("common.retry")}</Button>
      )}
    </li>
  );
}
