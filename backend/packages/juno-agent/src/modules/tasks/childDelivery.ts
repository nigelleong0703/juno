/**
 * CT-result: durable child-result delivery on the canonical run row.
 *
 * The stored parentRunId IS the boundary: a run that carries it is a child, so every final or
 * explicit send_message it produces is written as childResult and emits run.updated instead of a
 * chat bubble. The stored link is written at reservation, so runtime checks read the row and
 * never trust a model-controlled flag.
 */
import { createHash } from 'node:crypto';
import type { Store, ToolResult } from '../../contracts/index.js';
import type { Run } from '@agent-desktop/public-contracts';
import { docOwner } from '../../execution/execution-owner.js';
import { redactText } from '../../execution/harness/services/tool-projection.js';
import { runUpdatedEvent } from '../../execution/harness/services/agui-events.js';
import { captureOutputArtifact } from '../tools/outputArtifacts.js';
import { CHILD_RESULT_MAX_CHARS } from './childRead.js';

/** True when the run is a child-task run: the stored parent link is the only authority. */
export function isChildRun(run: Pick<Run, 'parentRunId'> | null | undefined): run is Run & { parentRunId: string } {
  return run?.parentRunId !== undefined && run.parentRunId.length > 0;
}

/**
 * The cancellation parts the plain effect checks before writing; the caller owns any durable
 * race, so this stays a plain promise and never touches Restate branding.
 */
export interface ChildResultGuard {
  readonly state: { cancelled: boolean };
  readonly signal: AbortSignal;
}

/**
 * PLAIN effect: store the child's result on its own run row and emit run.updated. No durable
 * race and no nested ctx.run here — the final-reply caller wraps it in
 * cancellation.race(() => ctx.run(...)); direct tool callers already run inside their fenced
 * durable action. Guards: cancellation state/signal first, then the canonical stored row must be
 * this exact child (parent link plus the run's own agent and conversation). The full model
 * transcript stays internal; only the bounded summary becomes public.
 */
export async function storeChildResult(
  services: { store: Store },
  input: { runId: string; agentId: string; conversationId: string; text: string },
  guard?: ChildResultGuard,
): Promise<boolean> {
  if (guard !== undefined && (guard.state.cancelled || guard.signal.aborted)) return false;
  const run = await services.store.get('runs', input.runId);
  if (!isChildRun(run)) return false;
  if (run.agentId !== input.agentId || run.conversationId !== input.conversationId) return false;
  // Cooperative stop can land while the canonical read was in flight: recheck before the write.
  if (guard !== undefined && (guard.state.cancelled || guard.signal.aborted)) return false;
  const text = input.text.trim();
  // The row keeps a bounded head; a longer result stays whole in an output artifact the parent reads with output_read.
  const ref = text.length > CHILD_RESULT_MAX_CHARS ? await captureChildResult(services.store, run, input.runId, text) : undefined;
  const stored = await services.store.patch('runs', input.runId, {
    childResult: text.slice(0, CHILD_RESULT_MAX_CHARS),
    ...(ref === undefined ? {} : { childResultRef: ref }),
  });
  await services.store.emit(runUpdatedEvent(stored));
  return true;
}

/** Full child text as an artifact; content-addressed step id, so a repeated send of the same text reuses it. */
async function captureChildResult(store: Store, child: { agentId: string; conversationId?: string } & Run, runId: string, text: string): Promise<string> {
  const parent = child.parentRunId === undefined ? null : await store.get('runs', child.parentRunId);
  const captured = await captureOutputArtifact(store, {
    ownerId: docOwner(child) ?? '',
    // The parent reads it, so the artifact carries the parent's agent (output_read checks the reader's agent).
    agentId: parent?.agentId ?? child.agentId,
    runId,
    stepId: 'child-result-' + createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
    tool: 'child_result',
    text,
    redact: redactText,
  });
  return captured.ref;
}

/** Outbound tools a child run may not call: each reaches a user, peer, room or file channel. */
const CHILD_BOUNDARY_TOOLS: ReadonlySet<string> = new Set(['post_to_room', 'message_agent', 'send_file', 'artifact_publish', 'space_publish', 'handoff', 'conversation_create']);

/** The refusal a blocked child attempt returns, before any effect. */
export const CHILD_BOUNDARY_REFUSAL = 'Error: child tasks are silent work items; report results through send_message or the final reply, and record blocked todos for missing input. Nothing was delivered.';

/**
 * The harness-side guard: refuse a child's outbound tool BEFORE approval or effect, so a silent
 * child can never bypass the boundary through a room, peer, file or new conversation.
 */
export async function refuseChildOutbound(services: { store: Store }, runId: string, toolName: string): Promise<ToolResult | null> {
  if (!CHILD_BOUNDARY_TOOLS.has(toolName)) return null;
  const run = await services.store.get('runs', runId);
  if (!isChildRun(run)) return null;
  return { content: [{ type: 'text', text: CHILD_BOUNDARY_REFUSAL }], isError: true };
}

/** Why a child's question is refused: missing input goes to the plan, never to a human request. */
export const CHILD_QUESTION_REFUSAL = 'Error: a child task cannot ask the user a question. Record the missing input as a blocked todo and report it in your final result; the parent run decides what happens next.';
