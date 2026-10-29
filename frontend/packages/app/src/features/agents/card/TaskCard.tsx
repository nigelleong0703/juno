import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, StatusPill, type StatusPillProps } from "@agent-desktop/ui";
import { useState } from "react";
import { ModelSetupAction } from "../../../components/run/ModelSetupAction";
import type { Run, Step } from "@agent-desktop/client";
import { Check, Loader2 } from "lucide-react";
import { StepTimeline } from "../../../components/run/StepRow";
import { useChildRuns } from "../../../data/child-runs";
import { useAgent, useItems, useRoutines, useRun } from "../../../data/queries";
import { useRequestPreview, useTaskForRun } from "../../../data/tasks";
import { startedByLine } from "../../../lib/auditInitiator";
import { t } from "../../../lib/i18n";
import { taskDetailText, taskPhase } from "../../../lib/taskView";
import { activityTitle, latestStepText, progressText, runDuration, runElapsedMs, runErrorText, visibleSteps } from "../../../lib/stepLine";
import { ShowMore, timeLabel } from "./parts";

/** The one status vocabulary for a task or a run (the iPhone's StatusTone + Fmt.status). */
const STATUS: Record<string, { tone: StatusPillProps["tone"]; label: string }> = {
  running: { tone: "success", label: "status.run.running" },
  queued: { tone: "neutral", label: "status.run.queued" },
  scheduled: { tone: "neutral", label: "status.run.scheduled" },
  waiting: { tone: "warning", label: "tasks.waitingForYou" },
  waiting_for_input: { tone: "warning", label: "tasks.waitingForYou" },
  blocked: { tone: "warning", label: "status.run.blocked" },
  completed: { tone: "success", label: "tasks.completed" },
  failed: { tone: "danger", label: "tasks.failed" },
  stopped: { tone: "neutral", label: "tasks.stopped" },
};
const STEP_PAGE = 8;

/**
 * Muse's task card, the one detail view of a piece of work: opened from the
 * "Working…" pill, a failed/stopped row and an Activity row (title: the task's when there is one, as on its Activity row). Status pill, title, when it started, the humanized
 * error, the agent's own summary, the latest screenshot, then the steps in words. The agent's verdict on its task
 * wins over the run's status: a run can end "completed" with the task failed.
 */
export function TaskCard({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  return (
    <Dialog open={runId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">{runId === null ? null : <TaskCardBody runId={runId} />}</DialogContent>
    </Dialog>
  );
}

function TaskCardBody({ runId }: { runId: string }) {
  const { data: run } = useRun(runId);
  const task = useTaskForRun(run?.agentId, runId);
  const { data: routines } = useRoutines();
  const routine = task?.origin.type === "routine" ? routines?.find((entry) => entry.id === task.routineId) : undefined;
  const { children } = useChildRuns(runId, run?.conversationId);
  // Helpers are left out of the run lists, so the parent's own list of child ids leads; any the cache knows are added.
  const childIds = [...new Set([...(run?.childRunIds ?? []), ...[...children].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((child) => child.id)])];
  const shotRef = run?.steps.findLast((step) => step.screenshotRef)?.screenshotRef;
  const { data: shot } = useRequestPreview(shotRef);
  // The task's own state wins; a run without a task reads in the run vocabulary.
  const runStatus = STATUS[run?.status ?? "completed"];
  const status = task ? taskPhase(task) : runStatus && { tone: runStatus.tone, label: t(runStatus.label) };
  const active = task?.status === "running" || task?.status === "waiting";
  // While it works, the headline is what the newest step (a running helper's, else the run's own) says, in the step list's words.
  const doing = active ? (latestStepText([...children].filter((child) => child.status === "running").flatMap((child) => child.steps)) ?? latestStepText(run?.steps ?? []) ?? (task?.progress ? progressText(task.progress) : undefined)) : undefined;
  const summary = run?.summary ?? (task ? (active ? doing : (task.resultLine ?? task.progress)) : undefined);
  const { data: taskAgent } = useAgent(task?.agentId);
  const detail = task ? taskDetailText(task, taskAgent?.name) : undefined;
  const took = run && run.status !== "running" ? runElapsedMs(run) : undefined;
  // The message that started the run: the person's message right before it.
  const { data: items } = useItems(run?.conversationId);
  const trigger = run
    ? items?.findLast((item) => item.type === "user_message" && Date.parse(item.at) <= Date.parse(run.startedAt) + 2000)
    : undefined;
  const title = activityTitle(task?.title ?? run?.title, trigger?.type === "user_message" ? trigger.text : undefined) ?? t("tasks.activity");
  return (
    <>
      <DialogHeader>
        <div>
          <StatusPill tone={status?.tone ?? "neutral"}>{status?.label ?? task?.status ?? run?.status}</StatusPill>
        </div>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {run ? t(run.finishedAt ? "tasks.finished" : "tasks.started", { time: timeLabel(run.finishedAt ?? run.startedAt) }) : null}
          {took === undefined ? "" : ` · ${runDuration(took)}`}
          {task ? ` · ${startedByLine(task.origin, routine?.name)}` : ""}
        </DialogDescription>
      </DialogHeader>
      {run?.error ? (
        <p className="text-sm text-danger">
          {runErrorText(run.error)} <ModelSetupAction error={run.error} />
        </p>
      ) : null}
      {detail ? <p className="text-sm text-fg-muted">{detail}</p> : null}
      {summary ? <p className="text-sm text-fg-muted">{summary}</p> : null}
      {shot ? <img src={shot} alt="" className="w-full rounded-xl border border-border" /> : null}
      <StepSection label={t("tasks.main")} steps={run?.steps ?? []} />
      {childIds.map((id) => (
        <ChildSection key={id} runId={id} />
      ))}
    </>
  );
}

/** One helper run: its title, whether it is still going, and its own steps (live while it runs). */
function ChildSection({ runId }: { runId: string }) {
  const { data: child } = useRun(runId);
  if (!child) return null;
  return <StepSection label={child.title || t("tasks.subtask")} status={child.status} steps={child.steps} />;
}

function StepSection({ label, status, steps }: { label: string; status?: Run["status"]; steps: readonly Step[] }) {
  const [shown, setShown] = useState(STEP_PAGE);
  const total = visibleSteps(steps).length;
  const live = status === "running" || status === "queued";
  if (total === 0 && !live && status !== "failed") return null;
  return (
    <div className="border-t border-border pt-3">
      <h3 className="flex items-center gap-1.5 pb-1 text-xs font-medium text-fg-subtle">
        <span className="line-clamp-2">{label}</span>
        {live ? <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-label={t("status.run.running")} /> : null}
        {status === "failed" ? <span className="text-danger">{t("tasks.failed")}</span> : null}
        {status === "completed" ? <Check className="size-3" aria-label={t("tasks.completed")} /> : null}
      </h3>
      <StepTimeline steps={steps} limit={shown} />
      <ShowMore hidden={total - shown} onClick={() => setShown((value) => value + STEP_PAGE)} />
    </div>
  );
}
