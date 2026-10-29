import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Doc, StoredRequest } from '../../../contracts/index.js';
import type { RunServices } from './run-types.js';
import { boundedSummary, redactText } from './tool-projection.js';
import { bindLegacyFence } from './replay.js';
import { stepAddedEvent } from './agui-events.js';
import type { ToolRunContext } from './replay.js';
import { BACKGROUND_OPTIONS } from '../../../modules/tasks/background-registry.js';

/** Harness scheduling controls never identify an external operation. */
export function recoveryArguments(args: Record<string, unknown>, mcp: boolean): Record<string, unknown> {
  if (!mcp) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => !BACKGROUND_OPTIONS.includes(key)));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
}

export function recoveryFingerprint(tool: string, args: Record<string, unknown>, binding: { ownerId: string; agentId: string; conversationId: string; connectionId?: string; account?: string }, mcp = false): string {
  return createHash('sha256').update(canonical({ ...binding, tool, args: recoveryArguments(args, mcp) })).digest('hex');
}

export function recoveryRequestId(stepId: string): string {
  return 'req_recovery_' + createHash('sha256').update(stepId).digest('hex').slice(0, 32);
}

export async function priorUnresolvedRecovery(
  store: RunServices['store'], agentId: string, fingerprint: string, stepId: string,
  connectionId?: string, account?: string,
): Promise<{ blocked?: StoredRequest; retryAuthorized: boolean }> {
  let cursor: string | undefined;
  do {
    const page = await store.list('requests', { where: { agentId }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    const found = page.items.find((request) => {
      const recovery = request.reconciliation;
      return recovery !== undefined && recovery.fingerprint === fingerprint
        && recovery.connectionId === connectionId && recovery.account === account
        && recovery.stepId !== stepId
        && (recovery.state === 'pending' || recovery.state === 'still_unknown'
          || (recovery.state === 'retry_consumed' && recovery.attemptStepId !== stepId));
    });
    if (found !== undefined) return { blocked: found, retryAuthorized: false };
    const ownRetry = page.items.find((request) => request.reconciliation?.fingerprint === fingerprint
      && request.reconciliation.connectionId === connectionId && request.reconciliation.account === account
      && request.reconciliation.state === 'retry_consumed' && request.reconciliation.attemptStepId === stepId);
    if (ownRetry !== undefined) return { retryAuthorized: true };
    const retry = page.items.find((request) => request.reconciliation?.fingerprint === fingerprint
      && request.reconciliation.connectionId === connectionId && request.reconciliation.account === account
      && request.reconciliation.state === 'user_confirmed_not_executed' && request.reconciliation.stepId !== stepId);
    if (retry !== undefined) {
      const consumed = await store.tx(async (tx) => {
        const current = await tx.getForUpdate?.('requests', retry.id);
        if (current?.reconciliation?.state !== 'user_confirmed_not_executed'
          || current.reconciliation.fingerprint !== fingerprint
          || current.reconciliation.connectionId !== connectionId || current.reconciliation.account !== account) return false;
        await tx.patch('requests', retry.id, { reconciliation: { ...current.reconciliation, state: 'retry_consumed', attemptStepId: stepId } });
        return true;
      });
      if (consumed) return { retryAuthorized: true };
      return { blocked: retry, retryAuthorized: false };
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return { retryAuthorized: false };
}

export const historicalFenceSchema = z.object({
  id: z.string(), runId: z.string(),
  execution: z.object({
    fencedAt: z.string().optional(),
    intent: z.object({ ownerId: z.string(), agentId: z.string(), tool: z.string(), fingerprint: z.string(), conversationId: z.string().optional(), connectionId: z.string().optional(), account: z.string().optional(), attempt: z.number().optional() }).optional(),
    reconciliation: z.object({ status: z.enum(['succeeded', 'not_executed', 'unknown', 'failed']) }).optional(),
    result: z.unknown().optional(),
  }).optional(),
});

export async function findPriorUnresolvedFence(
  store: RunServices['store'], agentId: string, currentStepId: string, fingerprint: string,
  ownerId: string, toolName: string, conversationId: string, connectionId?: string, account?: string,
): Promise<Doc<'steps'> | undefined> {
  const requests = new Set<string>();
  let requestCursor: string | undefined;
  do {
    const page = await store.list('requests', { where: { agentId }, limit: 100, ...(requestCursor === undefined ? {} : { cursor: requestCursor }) });
    for (const request of page.items) {
      const state = request.reconciliation?.state;
      if (request.reconciliation !== undefined && state !== 'user_reported_succeeded') requests.add(request.reconciliation.stepId);
    }
    requestCursor = page.nextCursor;
  } while (requestCursor !== undefined);

  let runCursor: string | undefined;
  do {
    const runs = await store.list('runs', { where: { agentId }, orderBy: 'at', order: 'desc', limit: 100, ...(runCursor === undefined ? {} : { cursor: runCursor }) });
    for (const run of runs.items) {
      let stepCursor: string | undefined;
      do {
        const page = await store.list('steps', { where: { runId: run.id }, limit: 100, ...(stepCursor === undefined ? {} : { cursor: stepCursor }) });
        for (const step of page.items) {
          if (step.id === currentStepId || requests.has(step.id)) continue;
          const parsed = historicalFenceSchema.safeParse(step);
          const execution = parsed.success ? parsed.data.execution : undefined;
          const intent = execution?.intent;
          if (!execution?.fencedAt || execution.result !== undefined || execution.reconciliation?.status === 'succeeded' || execution.reconciliation?.status === 'not_executed') continue;
          if (intent === undefined && run.conversationId === conversationId) {
            const task = await store.get('backgroundTasks', 'mcp-' + step.id);
            if (step.tool === toolName || step.target === toolName || (task?.agentId === agentId && task.conversationId === conversationId && task.label === toolName)) {
              await bindLegacyFence(store, step, { ownerId, agentId, conversationId, tool: toolName, fingerprint, ...(connectionId === undefined ? {} : { connectionId }), ...(account === undefined ? {} : { account }) });
              return (await store.get('steps', step.id)) ?? step;
            }
          }
          if (intent?.ownerId === ownerId && intent.agentId === agentId && intent.tool === toolName && intent.fingerprint === fingerprint && intent.conversationId === conversationId
            && intent.connectionId === connectionId && intent.account === account) return step;
        }
        stepCursor = page.nextCursor;
      } while (stepCursor !== undefined);
    }
    runCursor = runs.nextCursor;
  } while (runCursor !== undefined);
  return undefined;
}

export async function markRetryCompleted(store: RunServices['store'], agentId: string, fingerprint: string, attemptStepId: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await store.list('requests', { where: { agentId }, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    const request = page.items.find((item) => item.reconciliation?.fingerprint === fingerprint
      && item.reconciliation.state === 'retry_consumed' && item.reconciliation.attemptStepId === attemptStepId);
    if (request?.reconciliation) {
      await store.patch('requests', request.id, { reconciliation: { ...request.reconciliation, state: 'retry_completed' } });
      return;
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

const SECRET_ARGUMENT_KEY = /(?:password|passwd|passcode|secret|token|api[_-]?key|access[_-]?key|credential|authorization|cookie)/i;

function safeActionValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value).slice(0, 300);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth >= 3) return '[omitted]';
  if (Array.isArray(value)) return value.slice(0, 12).map((entry) => safeActionValue(entry, depth + 1));
  if (typeof value !== 'object') return '[omitted]';
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_ARGUMENT_KEY.test(key))
    .slice(0, 20).map(([key, item]) => [key, safeActionValue(item, depth + 1)]));
}

export function recoveryActionSummary(toolName: string, args: Record<string, unknown>, conversationId: string, attemptedAt: string): string {
  return boundedSummary({ tool: toolName, target: `conversation ${conversationId}`, attemptedAt, parameters: safeActionValue(args) });
}


/** Every authorized retry gets a fresh step identity and never inherits the original execution cache. */
export async function createRecoveryRetryStep(ctx: ToolRunContext, store: RunServices['store'], original: Doc<'steps'>, runId: string): Promise<Doc<'steps'>> {
  const attemptId = 'stp_retry_' + createHash('sha256').update(original.id + ':attempt:1').digest('hex').slice(0, 32);
  return ctx.run(`step:${attemptId}:create`, async () => {
    const existing = await store.get('steps', attemptId);
    if (existing !== null) return existing;
    const next: Doc<'steps'> = { ...original, id: attemptId, runId, index: original.index + 1, verb: 'Retried', status: 'running', startedAt: new Date().toISOString(), durationMs: 0 };
    Reflect.deleteProperty(next, 'execution');
    await store.put('steps', next, { runId });
    await store.emit(stepAddedEvent(next));
    return next;
  });
}
