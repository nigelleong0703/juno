import type { Agent, Computer, ComputerState, ScreenState, Step } from "@agent-desktop/client";
import type { ComputerViewMode, HeaderState, ScreenModeInput, ScreenScenario } from "./types";

/**
 * Pure derivations for the Computer surface (E2). Keeping these as plain functions — no React,
 * no i18n, no ui imports — makes the mode/state mapping directly unit-testable.
 */

// --- Mock desktop scenario per agent ---------------------------------------

/** The page each agent is "known" for, so the mock desktop reads as that agent's machine. */
export const SCENARIO_BY_AGENT: Record<string, ScreenScenario> = {
  "agent-juno": "research",
  "agent-patch": "github",
  "agent-ledger": "sheet",
  "agent-echo": "docs",
  "agent-scout": "profile",
  "agent-atlas": "flights",
  "agent-new": "desktop",
};

/**
 * Pages a shell/file/browser step maps to when nothing more specific is on screen. They are
 * deliberately generic, so they never override an agent's own signature page — only a *specific*
 * page (a PR, a sheet, a doc) does. This keeps Juno's screen on the Firecracker docs even while
 * she is running shell commands.
 */
const GENERIC_SCENARIOS: readonly ScreenScenario[] = ["code", "browser"];

function scenarioFromStep(step: Step): ScreenScenario | undefined {
  const haystack = `${step.verb} ${step.target} ${step.input?.url ?? ""}`.toLowerCase();
  if (step.kind === "browser") {
    // Match "github.com" / a PR path, not a bare "github" — `*.github.io` is a docs host, not a PR.
    if (haystack.includes("github.com") || haystack.includes("pull")) {
      return "github";
    }
    if (haystack.includes("sheet") || haystack.includes("stripe") || haystack.includes("invoice")) {
      return "sheet";
    }
    // Only an explicit Notion URL maps to the meeting-notes page — a bare "docs" is too common
    // (e.g. the Firecracker docs host) to identify it.
    if (haystack.includes("notion")) return "docs";
    if (haystack.includes("gmail") || haystack.includes("mail") || haystack.includes("inbox")) {
      return "mail";
    }
    if (haystack.includes("linkedin") || haystack.includes("talent") || haystack.includes("profile")) {
      return "profile";
    }
    if (haystack.includes("flight") || haystack.includes("airline")) return "flights";
    return "browser";
  }
  if (step.kind === "shell" || step.kind === "file") return "code";
  if (step.kind === "mcp") {
    if (haystack.includes("gmail") || haystack.includes("mail")) return "mail";
    if (haystack.includes("github.com")) return "github";
    return "browser";
  }
  return undefined;
}

/**
 * Pick the page the mock desktop should show. A *specific* live step wins (so the screen tracks
 * what the agent is actually doing); a generic step (shell/file/browser) only wins for an agent
 * with no signature page; otherwise fall back to the agent's signature page.
 */
export function deriveScenario(agentId: string | undefined, step?: Step): ScreenScenario {
  const signature = agentId ? SCENARIO_BY_AGENT[agentId] : undefined;
  if (step) {
    const fromStep = scenarioFromStep(step);
    if (fromStep && !GENERIC_SCENARIOS.includes(fromStep)) return fromStep;
    if (fromStep && !signature) return fromStep;
  }
  if (signature) return signature;
  return "desktop";
}

// --- Header chip -----------------------------------------------------------

export interface HeaderStateInput {
  computer: Pick<Computer, "state">;
  agent?: Pick<Agent, "status">;
  /** Pending requests waiting on the user for this agent. */
  pendingCount: number;
}

/**
 * Map the (computer state, agent status, pending requests) triple onto the single header chip.
 * Pending work outranks machine state; a paused/asleep machine outranks the agent's own status.
 */
export function resolveHeaderState(input: HeaderStateInput): HeaderState {
  if (input.pendingCount > 0) return "needs-you";
  const { state } = input.computer;
  if (state === "asleep") return "asleep";
  if (state === "paused" || state === "updating" || state === "rebooting") return "paused";
  if (input.agent?.status === "working") return "working";
  return "running";
}

/** i18n key for a header state (rendered with `t(key)`). */
export const HEADER_STATE_LABEL: Record<HeaderState, string> = {
  running: "computer.state.running",
  working: "computer.state.working",
  asleep: "computer.state.asleep",
  paused: "computer.state.paused",
  "needs-you": "computer.state.needsYou",
};

/**
 * Semantic tone for a header state, matching `StatusPill`'s tones. `needs-you` is rendered by the
 * pane as a small accent dot + muted text rather than a coloured pill (owner feedback: no
 * orange for "needs you" — orange/red are reserved for real errors), so its tone here is only a
 * fallback.
 */
export const HEADER_STATE_TONE: Record<HeaderState, "neutral" | "success" | "warning" | "info" | "accent"> = {
  running: "success",
  working: "accent",
  asleep: "neutral",
  paused: "warning",
  "needs-you": "info",
};

// --- View mode -------------------------------------------------------------

/**
 * Decide how the screen is framed. Order matters: a sleeping machine cannot be in control, and a
 * pending sign-in / approval is more urgent than "you happen to hold the keyboard".
 */
export function deriveScreenMode(input: ScreenModeInput): ComputerViewMode {
  if (input.computerState === "asleep") return "asleep";
  if (input.teaching) return "teach";
  if (input.signinPending) return "signin";
  if (input.needsYouPending) return "needs-you";
  if (input.userInControl) return "control";
  return "watch";
}

/** True when the mode captures the keyboard/mouse (drives `viewOnly` on the live screen). */
export function modeIsInteractive(mode: ComputerViewMode): boolean {
  return mode === "control";
}

/** Modes that pause the agent's model and therefore block interaction. */
export function modePausesModel(mode: ComputerViewMode): boolean {
  return mode === "signin";
}

// --- Live stream target ----------------------------------------------------

/**
 * Resolve a computer's websocket endpoint. Read an optional `streamUrl` defensively
 * and fall back to the dev-setting provided by `resolveDevStreamTarget`.
 */
export function screenStreamUrl(computer: Computer | undefined): string | undefined {
  const url = (computer as { streamUrl?: unknown } | undefined)?.streamUrl;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

/**
 * How the live screen area should present one agent's display. `ready` hands the real websocket
 * ticket to noVNC; every other value is an honest placeholder, never invented pixels.
 */
export type ScreenPresence = "ready" | "starting" | "asleep" | "error" | "missing";

/** Fold a screen's own lifecycle onto the computer-level status pill vocabulary. */
export function screenStateToComputerState(state: ScreenState): ComputerState {
  if (state === "live") return "running";
  if (state === "starting") return "updating";
  if (state === "error") return "error";
  return "asleep";
}

/** Classify presence for the screen area from the screen record (or its absence). */
export function resolveScreenPresence(
  screen: { state: ScreenState } | null | undefined,
): ScreenPresence {
  if (!screen) return "missing";
  if (screen.state === "live") return "ready";
  if (screen.state === "starting") return "starting";
  if (screen.state === "error") return "error";
  return "asleep";
}
