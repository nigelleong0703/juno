/**
 * Real-task cases. A case is a written test: the user's message(s), a script for what the simulated user does when the agent
 * asks something (`user`), and checks on what actually happened (tool calls, steps, artifacts, files, URLs). No LLM plays the
 * user and no check reads the agent's wording as proof of work.
 */

export interface ToolCallObs {
  name: string;
  args: Record<string, unknown>;
  /** The run that made the call (a sub-task has its own). */
  runId: string;
}

export interface ToolResultObs {
  toolName: string;
  isError: boolean;
  text: string;
  runId: string;
}

export interface StepObs {
  runId: string;
  verb: string;
  target: string;
  status: string;
  startedAt: string;
  url?: string;
}

/** One request the agent raised and what the scripted user did with it. */
export interface Interaction {
  requestId: string;
  kind: string;
  title: string;
  /** Title, summary and the payload's action/why/purchase as one string, for matching and reading the report. */
  text: string;
  purchase: boolean;
  at: string;
  action: 'approve' | 'deny' | 'answer';
  /** Which rule of the case decided it (`default` when none matched). */
  rule: string;
  answers?: Record<string, string>;
  note?: string;
}

export interface TurnObs {
  message: string;
  conversationId: string;
  runIds: string[];
  /** Status of the conversation's top-level run; `timeout` when the case's time ran out. */
  status: string;
  /** The run's own error text when it failed. */
  runError?: string;
  /** What the agent said to the user, in order. */
  replies: string[];
}

export interface Observed {
  taskId: string;
  turns: TurnObs[];
  calls: ToolCallObs[];
  results: ToolResultObs[];
  steps: StepObs[];
  interactions: Interaction[];
  durationMs: number;
  costUsd: number;
  /** False when any run had no price for its model: `costUsd` is then only what is priced, and the price is unknown. */
  costKnown: boolean;
  inputTokens: number;
  outputTokens: number;
}

/** What the checks can reach: the public API as the user, and a request to the api port with a Host header. */
export interface CheckEnv {
  api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  hostRequest(host: string, path: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>;
  artifactHost: string;
  userId: string;
  /** Run the chat digest of every conversation of the account now, like the quiet window would (`ChatDigest.runNow`). */
  runMemoryJob(): Promise<void>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export type Check = (observed: Observed, env: CheckEnv) => Promise<CheckResult[]> | CheckResult[];

export interface Turn {
  message: string;
  /** Start a new conversation for this message (default: the first turn opens one, later turns continue it). */
  newConversation?: boolean;
  /** Runs after the turn's runs finished, before the next message (e.g. trigger a background job). */
  afterTurn?: (env: CheckEnv) => Promise<void>;
}

export interface UserScript {
  /** Answers when the agent asks a question: first rule whose pattern matches the field's prompt (and options) wins. */
  replies?: Array<{ match: RegExp; answer: string }>;
  /** Used when no rule matches. */
  fallbackReply: string;
  /** Rules for approval cards, first match wins; `text` is matched against title, summary, action, why and the purchase. */
  approvals?: Array<{ name: string; kind?: string; text?: RegExp; purchase?: boolean; action: 'approve' | 'deny' }>;
  /** Anything no approval rule matched. */
  defaultApproval: 'approve' | 'deny';
  /** The agent asks the user to log in / take over the screen: this is the answer (the request is declined with this note). */
  takeover?: string;
}

export interface TaskSpec {
  id: string;
  title: string;
  turns: Turn[];
  user: UserScript;
  /** Starts a local server the case's pages come from; returns what stops it. Runs once before the case. */
  fixture?: () => Promise<() => Promise<void>>;
  /** Set-up through the public API before the first message (for example adding an app the case uses). */
  before?: (env: CheckEnv) => Promise<void>;
  /** Whole-case time limit. */
  timeoutMs: number;
  checks: Check[];
}

export const pass = (name: string, detail?: string): CheckResult => ({ name, ok: true, ...(detail === undefined ? {} : { detail }) });
export const fail = (name: string, detail: string): CheckResult => ({ name, ok: false, detail });
export const verdict = (name: string, ok: boolean, detail: string): CheckResult => (ok ? pass(name) : fail(name, detail));
