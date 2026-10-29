import type {
  AgentStatus,
  ComputerState,
  RequestStatus,
  RoutineStatus,
  RunStatus,
  StepStatus,
} from "@agent-desktop/client";
import type { StatusPillProps } from "@agent-desktop/ui";
import {
  AlertTriangle,
  Ban,
  BedDouble,
  CalendarClock,
  CircleCheck,
  CircleAlert,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  Clock,
  Hammer,
  Hand,
  Loader2,
  Pause,
  Play,
  Power,
  RefreshCw,
  ShieldAlert,
  TimerOff,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { t } from "./i18n";

export type Tone = StatusPillProps["tone"];

export interface StatusMeta {
  /** Semantic tone passed straight to `<StatusPill tone=…>`. */
  tone: Tone;
  /** lucide icon component, rendered by callers as `<meta.icon />`. */
  icon: LucideIcon;
  /** i18n key — render with `t(meta.label)`. */
  label: string;
}

// --- AgentStatus (working / idle / sleeping / needs_you / paused / error) --
export const agentStatusMeta: Record<AgentStatus, StatusMeta> = {
  working: { tone: "accent", icon: Hammer, label: "status.agent.working" },
  idle: { tone: "neutral", icon: CircleDashed, label: "status.agent.idle" },
  sleeping: { tone: "neutral", icon: BedDouble, label: "status.agent.sleeping" },
  needs_you: { tone: "warning", icon: Hand, label: "status.agent.needsYou" },
  paused: { tone: "neutral", icon: Pause, label: "status.agent.paused" },
  error: { tone: "danger", icon: AlertTriangle, label: "status.agent.error" },
};

// --- ComputerState (running / paused / asleep / updating / rebooting / error)
export const computerStateMeta: Record<ComputerState, StatusMeta> = {
  running: { tone: "success", icon: Play, label: "status.computer.running" },
  // Owner feedback 2026-10-05: a paused computer is neutral (muted), not a warning.
  paused: { tone: "neutral", icon: Pause, label: "status.computer.paused" },
  asleep: { tone: "neutral", icon: BedDouble, label: "status.computer.asleep" },
  updating: { tone: "info", icon: RefreshCw, label: "status.computer.updating" },
  rebooting: { tone: "info", icon: Power, label: "status.computer.rebooting" },
  error: { tone: "danger", icon: AlertTriangle, label: "status.computer.error" },
};

// --- RunStatus (scheduled / queued / running / waiting_for_input / completed / failed / stopped)
export const runStatusMeta: Record<RunStatus, StatusMeta> = {
  scheduled: { tone: "neutral", icon: CalendarClock, label: "status.run.scheduled" },
  queued: { tone: "neutral", icon: TimerOff, label: "status.run.queued" },
  running: { tone: "accent", icon: Loader2, label: "status.run.running" },
  waiting_for_input: { tone: "warning", icon: CircleHelp, label: "status.run.waiting" },
  completed: { tone: "success", icon: CircleCheck, label: "status.run.completed" },
  failed: { tone: "danger", icon: AlertTriangle, label: "status.run.failed" },
  stopped: { tone: "neutral", icon: CircleSlash, label: "status.run.stopped" },
  blocked: { tone: "warning", icon: CircleAlert, label: "status.run.blocked" },
};

// --- RequestStatus (pending / approved / denied / answered / expired) ------
export const requestStatusMeta: Record<RequestStatus, StatusMeta> = {
  pending: { tone: "warning", icon: Clock, label: "status.request.pending" },
  approved: { tone: "success", icon: CircleCheck, label: "status.request.approved" },
  denied: { tone: "danger", icon: Ban, label: "status.request.denied" },
  answered: { tone: "info", icon: CircleCheck, label: "status.request.answered" },
  expired: { tone: "neutral", icon: TimerOff, label: "status.request.expired" },
};

// --- RoutineStatus (active / paused / error) -------------------------------
export const routineStatusMeta: Record<RoutineStatus, StatusMeta> = {
  active: { tone: "success", icon: Workflow, label: "status.routine.active" },
  paused: { tone: "neutral", icon: Pause, label: "status.routine.paused" },
  error: { tone: "danger", icon: ShieldAlert, label: "status.routine.error" },
  needs_setup: { tone: "warning", icon: CircleAlert, label: "status.routine.needsSetup" },
};

/** A routine waiting on an app does not run, whatever its enabled flag says: its switch shows off and is locked. */
export const routineRuns = (routine: { enabled: boolean; status: RoutineStatus }): boolean => routine.enabled && routine.status !== "needs_setup";

// --- StepStatus (pending / running / completed / failed / skipped) ---------
export const stepStatusMeta: Record<StepStatus, StatusMeta> = {
  pending: { tone: "neutral", icon: CircleDashed, label: "status.step.pending" },
  running: { tone: "accent", icon: Loader2, label: "status.step.running" },
  completed: { tone: "success", icon: CircleCheck, label: "status.step.completed" },
  failed: { tone: "danger", icon: AlertTriangle, label: "status.step.failed" },
  skipped: { tone: "neutral", icon: CircleSlash, label: "status.step.skipped" },
};

/** Localized label for a status meta. */
export function statusLabel(meta: StatusMeta): string {
  return t(meta.label);
}

/** Tree-shake-friendly icon resolver for step `kind` (computer/browser/shell/…). */
export const stepKindIcon: Record<string, LucideIcon> = {
  computer: Power,
  browser: Power,
  shell: Hammer,
  file: Workflow,
  mcp: Workflow,
  think: CircleHelp,
};
