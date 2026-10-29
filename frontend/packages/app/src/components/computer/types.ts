import type { ComputerState, StepKind } from "@agent-desktop/client";

/**
 * Shared types for the Computer surface (E2). `LiveScreen` is the picture, `ComputerView` frames
 * it in one of several modes, and `ComputerPane` is the right-hand column that hosts the tabs.
 */

/** What the screen is doing — drives the banner and the interaction affordances (§6). */
export type ComputerViewMode =
  | "watch"
  | "control"
  | "signin"
  | "teach"
  | "needs-you"
  | "asleep";

/** The chip in the pane header: Running / Working / Asleep / Paused / Needs you. */
export type HeaderState = "running" | "working" | "asleep" | "paused" | "needs-you";

/** The page a screen depicts; the pure `deriveScenario` helper maps an agent to one. */
export type ScreenScenario =
  | "research"
  | "github"
  | "sheet"
  | "mail"
  | "docs"
  | "profile"
  | "flights"
  | "code"
  | "browser"
  | "signin"
  | "asleep"
  | "desktop";

/** Everything `deriveScreenMode` needs; kept a plain object so it is trivially testable. */
export interface ScreenModeInput {
  computerState: ComputerState;
  /** The user currently holds the keyboard/mouse. */
  userInControl: boolean;
  /** A pending `signin` request for this agent. */
  signinPending: boolean;
  /** A pending approval/question for this agent. */
  needsYouPending: boolean;
  /** The agent is recording a demonstrated task. */
  teaching: boolean;
}

// --- Live screen adapter contract (§6) -------------------------------------

/** A noVNC/websockify endpoint: a websocket URL plus an optional VNC password. */
export interface LiveScreenTarget {
  /** `ws://` or `wss://` websockify endpoint. */
  url: string;
  /** VNC password (if the endpoint requires one). */
  password?: string;
}

export type LiveScreenState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface LiveScreenStateDetail {
  state: LiveScreenState;
  /** Human-readable reason for `disconnected` / `error`. */
  message?: string;
  /** Whether a disconnect was clean (noVNC's `disconnect.detail.clean`). */
  clean?: boolean;
}

export type LiveScreenStateHandler = (detail: LiveScreenStateDetail) => void;

/**
 * The picture adapter (§6). `ComputerView` never knows which adapter a caller configured — it only
 * talks to this interface.
 */
export interface LiveScreenAdapter {
  connect(target: LiveScreenTarget, options: { viewOnly: boolean }): void;
  setViewOnly(viewOnly: boolean): void;
  disconnect(): void;
  /** Subscribe to connection state; returns an unsubscribe fn. */
  onState(handler: LiveScreenStateHandler): () => void;
  /** Ctrl+C on the remote; the copied text arrives through `onClipboard`. */
  copy(): void;
  /** Put text on the remote clipboard, then Ctrl+V into the focused field. */
  paste(text: string): void;
  /** Ctrl+V on the remote alone: the remote clipboard already holds what should be pasted (an image put there by the side channel). */
  pressPaste(): void;
  /** Text the remote computer put on its clipboard (after `copy`). */
  onClipboard(handler: (text: string) => void): () => void;
}

/** Intrinsic noVNC framebuffer size in pixels (canvas width/height attributes). */
export interface FramebufferSize {
  width: number;
  height: number;
}

/** Handler receiving validated framebuffer dimensions. */
export type FramebufferSizeHandler = (size: FramebufferSize) => void;

/** A step kind used when deriving the scenario from the agent's latest activity. */
export type { StepKind };
