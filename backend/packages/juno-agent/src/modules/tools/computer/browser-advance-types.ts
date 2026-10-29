import { z } from 'zod';
import type { AdvanceHistory } from './browser-advance-history.js';
import type { ToolResult } from '../../../contracts/index.js';
import type { SystemOne } from '../../../ports/system-one/index.js';
import type { BrowserResult } from './contract.js';
import { ON_SCHEMA } from './shared.js';

export const BROWSER_ADVANCE_TOOL = 'browser.advance';
export const ADVANCE_MAX_ACTIONS = 6;
export const ADVANCE_DEFAULT_ACTIONS = 4;
export const ADVANCE_MAX_VALUES = 24;

const valueMapSchema = z.record(z.string().min(1).max(240), z.string().max(2_000)).refine(
  (values) => Object.keys(values).length <= ADVANCE_MAX_VALUES,
  { message: `values may name at most ${String(ADVANCE_MAX_VALUES)} labels` },
);

export const browserAdvanceArgsSchema = z.object({
  stage: z.enum(['form', 'interact']).optional(),
  goal: z.string().trim().min(1).max(2_000),
  values: valueMapSchema.optional(),
  tab: z.string().min(1).max(16).optional(),
  on: ON_SCHEMA,
  maxActions: z.number().int().min(1).max(ADVANCE_MAX_ACTIONS).optional(),
}).strict();
export type BrowserAdvanceArgs = z.infer<typeof browserAdvanceArgsSchema>;

export type SnapshotPage = Extract<BrowserResult, { action: 'snapshot' }>;

export interface AdvanceObservation {
  page: SnapshotPage;
}

export type AdvanceAction =
  | { kind: 'click'; ref: string; role: string; label: string }
  | { kind: 'type'; ref: string; role: string; label: string; valueKey: string; value: string }
  | { kind: 'fill'; fields: Array<{ ref: string; role: string; label: string; valueKey: string; value: string }> }
  | { kind: 'get_text' };

export interface AdvanceCandidate {
  key: string;
  action: AdvanceAction;
  description: string;
}

export interface AdvanceProgressEntry {
  step: number;
  action: 'click' | 'type' | 'fill' | 'get_text';
  target: Array<{ ref: string; role: string; label: string; valueLabel?: string }>;
  observed: Array<Record<string, unknown>>;
  result: 'changed' | 'no-observed-effect' | 'read' | 'error' | 'suspended';
  error?: string;
}

export interface AdvanceDecisionRecord {
  kind: 'chosen' | 'unavailable' | 'timeout' | 'low-confidence' | 'invalid' | 'error';
  key?: string;
  probability?: number;
  margin?: number;
}

export type AdvanceExecution = { kind: 'completed'; result: ToolResult } | { kind: 'cancelled' };
export type BrowserAdvanceOutcome = { kind: 'completed'; result: ToolResult } | { kind: 'cancelled' };

export interface RunBrowserAdvanceOptions {
  args: BrowserAdvanceArgs;
  ownerId: string;
  agentId: string;
  conversationId: string;
  runId: string;
  stepId?: string;
  signal: AbortSignal;
  systemOne?: SystemOne;
  decisionTimeoutMs?: number;
  history?: AdvanceHistory;
  loadHistory?(page: AdvanceObservation): Promise<AdvanceHistory | undefined>;
  journal<T>(key: string, action: () => Promise<T>): Promise<T>;
  execute(action: 'snapshot' | 'click' | 'type' | 'fill' | 'get_text', args: Record<string, unknown>): Promise<AdvanceExecution>;
}
