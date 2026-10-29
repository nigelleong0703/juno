import { z } from 'zod';
import type { Run } from '@agent-desktop/public-contracts';
import type { Brain, Store } from '../../../contracts/index.js';
import { emitAgentStatus, withLiveStatus } from '../../agent-status.js';
import { meaningfulRole } from '../../brain/social-format.js';
import { emitItemAdded } from '../../conversation-activity.js';
import { harnessText } from '../../../modules/harness/loader.js';
import { jsonObjectIn } from '../../../modules/memory/jobs/model-json.js';
import { putRunPreservingChild } from './run-reservation.js';
import { runUpdatedEvent } from './agui-events.js';
import type { RunInput, RunServices } from './run-types.js';

/** Background auxiliary work for a run: once per agent, a suggested role (BACKEND §10.11); and the run's title the agent gives. */

const SOURCE_MAX_CHARS = 500;
const ROLE_MESSAGE_THRESHOLD = 3;

const roleReplySchema = z.object({
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(300),
});

/**
 * Start the auxiliary calls for one run without awaiting them: the run never waits on, or fails
 * because of, a model call. Call it from a journaled step so a Restate replay does not repeat it.
 */
export function startRunAuxiliaries(services: RunServices, input: RunInput, runId: string): void {
  const brain = services.brain;
  const ask = brain.quickText?.bind(brain);
  if (ask === undefined) return;
  const quickText = (prompt: string): Promise<string | null> => ask(prompt, input.agentId);
  void suggestRole(services.store, quickText, input).catch(() => undefined);
}

/**
 * The run's title is the agent's own name for its work: the first task it creates (task_update) or helper it starts
 * (child_spawn) in a top-level run. Until then the run keeps the raw wake text; later tasks do not rename it.
 */
export async function nameRunByAgent(store: Store, runId: string, title: string): Promise<void> {
  await store.tx(async (tx) => {
    const run = await tx.get('runs', runId);
    if (run === null || run.parentRunId !== undefined || run.titleGenerated === true) return;
    const saved = await putRunPreservingChild(tx, { ...run, title: title.slice(0, 120), titleGenerated: true }, false);
    await tx.emit(runUpdatedEvent(saved));
    await emitAgentStatus(tx, saved.agentId);
  });
}

function rolePrompt(messages: string[]): string {
  return harnessText('aux.role_suggestion', { messages: messages.map((text) => '- ' + text.slice(0, SOURCE_MAX_CHARS)).join('\n') });
}

/** The JSON object in the reply, validated; undefined when the reply is not a usable suggestion. */
export function parseRoleReply(reply: string | null): { title: string; description: string } | undefined {
  if (reply === null) return undefined;
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start === -1 || end < start) return undefined;
  try {
    const parsed = roleReplySchema.safeParse(JSON.parse(reply.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Placeholder titles that carry no role: the default 'New agent' and the agentCreate tool's fallback 'Agent'. */
const PLACEHOLDER_TITLES = new Set(['Agent']);

/** Eligible when the agent has no configured role, no pending or dismissed suggestion. */
function roleEligible(agent: { title: string; roleSuggestion?: unknown; roleSuggestionDismissedAt?: string }): boolean {
  const role = meaningfulRole(agent.title);
  const unset = role === undefined || PLACEHOLDER_TITLES.has(role);
  return unset && agent.roleSuggestion === undefined && agent.roleSuggestionDismissedAt === undefined;
}

async function suggestRole(
  store: Store,
  quickText: (prompt: string) => Promise<string | null>,
  input: RunInput,
): Promise<void> {
  const agent = await store.get('agents', input.agentId);
  if (agent === null || !roleEligible(agent)) return;
  const conversation = await store.get('conversations', input.conversationId);
  if (conversation === null || conversation.kind !== 'direct') return;
  // Items are written before the run starts, so the message that started this run is already counted.
  const items = await store.list('items', { where: { conversationId: input.conversationId }, orderBy: 'at', order: 'asc', limit: 200 });
  const userTexts = items.items.flatMap((item) => (item.type === 'user_message' ? [item.text] : []));
  if (userTexts.length < ROLE_MESSAGE_THRESHOLD) return;
  const suggestion = parseRoleReply(await quickText(rolePrompt(userTexts.slice(0, ROLE_MESSAGE_THRESHOLD))));
  if (suggestion === undefined) return;
  await store.tx(async (tx) => {
    // The row lock serializes two runs that both passed eligibility, so only one suggestion (and card) lands.
    if (tx.getForUpdate === undefined) throw new Error('role suggestion needs a row lock');
    const current = await tx.getForUpdate('agents', input.agentId);
    if (current === null || !roleEligible(current)) return;
    const now = new Date().toISOString();
    const stored = await tx.put('agents', { ...current, roleSuggestion: { ...suggestion, createdAt: now }, updatedAt: now });
    await tx.emit({ type: 'agent.updated', agent: await withLiveStatus(tx, stored) });
    // The suggestion also lands in the chat as a card (BACKEND §10.11); one item per suggestion.
    const item = {
      id: `rsg-${input.agentId}-${Date.parse(now)}`,
      conversationId: input.conversationId,
      type: 'role_suggestion' as const,
      agentId: input.agentId,
      title: suggestion.title,
      description: suggestion.description,
      suggestionAt: now,
      at: now,
    };
    await tx.put('items', item, { conversationId: input.conversationId });
    await emitItemAdded(tx, input.conversationId, item);
  });
}

/** Task summary and plain-language step lines, written once when a run reaches a terminal status (BACKEND §10.15). */
const stepLinesSchema = z.object({
  summary: z.string().optional(),
  steps: z.array(z.object({ index: z.number(), title: z.string().optional(), detail: z.string().optional() })).optional(),
});
const clip = (text: string | undefined, max: number): string | undefined => {
  const t = text?.trim();
  return t === undefined || t === '' ? undefined : t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/** The run with the model's summary and step title/detail applied; unknown indexes are ignored, lengths clipped. Undefined when the reply is unusable. */
export function applyStepSummaries(run: Run, reply: string | null): Run | undefined {
  const parsed = reply === null ? undefined : stepLinesSchema.safeParse(jsonObjectIn(reply));
  if (parsed === undefined || !parsed.success) return undefined;
  const lines = new Map((parsed.data.steps ?? []).map((line) => [line.index, line]));
  const steps = run.steps.map((step) => {
    const line = lines.get(step.index);
    const title = clip(line?.title, 80);
    const detail = clip(line?.detail, 200);
    return title === undefined ? step : { ...step, title, ...(detail === undefined ? {} : { detail }) };
  });
  const summary = clip(parsed.data.summary, 300);
  if (summary === undefined && steps.every((step, i) => step === run.steps[i])) return undefined;
  return { ...run, steps, ...(summary === undefined ? {} : { summary }) };
}

/**
 * After a run is terminal, ask for its summary and step lines in one call, without awaiting (like the other auxiliaries:
 * call it from a journaled step). Skips background runs and runs with no steps; any failure leaves the run as is.
 */
export function startStepSummaries(services: RunServices, runId: string): void {
  const brain = services.brain;
  if (brain.quickText === undefined) return;
  const quickText = brain.quickText.bind(brain);
  void summarizeSteps(services.store, quickText, runId).catch(() => undefined);
}

async function summarizeSteps(store: Store, quickText: (prompt: string, agentId?: string) => Promise<string | null>, runId: string): Promise<void> {
  const run = await store.get('runs', runId);
  if (run === null || run.kind === 'background' || run.steps.length === 0) return;
  const recent = await store.list('items', { where: { conversationId: run.conversationId ?? '' }, orderBy: 'at', order: 'desc', limit: 50 });
  const reply = recent.items.find((item) => item.type === 'agent_message' && item.runId === runId);
  const stepLines = run.steps.map((step) => `${step.index}. ${step.verb} ${step.target} -> ${(step.output?.summary ?? step.output?.text ?? '').slice(0, 200)}`);
  const prompt = harnessText('aux.step_lines', {
    task: run.title.slice(0, SOURCE_MAX_CHARS),
    finalReply: reply?.type === 'agent_message' ? reply.markdown.slice(0, 600) : '(none)',
    steps: stepLines.join('\n'),
  });
  const text = await quickText(prompt, run.agentId);
  await store.tx(async (tx) => {
    const current = await tx.get('runs', runId);
    const updated = current === null ? undefined : applyStepSummaries(current, text);
    if (updated === undefined) return;
    await tx.emit(runUpdatedEvent(await putRunPreservingChild(tx, updated, false)));
  });
}
