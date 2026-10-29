import { z } from 'zod';
import { sessionKey, type Enqueuer, type Store, type Tool, type ToolContext, type ToolResult, type WakeEvent } from '../../../contracts/index.js';
import { newId, nowIso } from '../util.js';
import { durationMs } from '../duration.js';
import { BACKGROUND_LIMIT_TEXT, backgroundCapRefusal, backgroundSpawnOf } from '../../tasks/child-background.js';
import { recordBackgroundTask, taskLabel } from '../../tasks/background-registry.js';

const waitForSchema = z.object({
  filter: z.record(z.string(), z.unknown()),
  timeout: z.string().optional(),
  notify: z.boolean().optional(),
});

export function createWaitForTool(opts: { store: Store; enqueuer: Enqueuer }): Tool {
  return {
    name: 'wait_for',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'object' },
        timeout: { type: 'string', description: '' },
        notify: { type: 'boolean' },
      },
      required: ['filter'],
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = waitForSchema.parse(args);
      const awakeableId = newId('wk');
      const timeoutMs = parseTimeoutMs(parsed.timeout);
      const expiresAt = new Date(Date.now() + timeoutMs).toISOString();

      const notify = parsed.notify === true;
      const spawn = backgroundSpawnOf(ctx.wake, ctx.runId);
      const generation = spawn.generation;
      if (notify && (await backgroundCapRefusal(opts.store, ctx.conversationId, spawn)) !== undefined) return { content: [{ type: 'text', text: BACKGROUND_LIMIT_TEXT }], isError: true };
      const subscription = {
        id: awakeableId,
        ownerId: ctx.ownerId,
        // A notify subscription belongs to the session, not this run: the run is not suspended on it.
        ...(notify ? { notify: true, generation, originRunId: ctx.runId } : { runId: ctx.runId }),
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        filter: parsed.filter,
        expiresAt,
        createdAt: nowIso(),
      };

      await ctx.step('store_subscription', async () => {
        await opts.store.put('subscriptions', subscription);
      });

      if (notify) {
        await ctx.step('record_task', () => recordBackgroundTask(opts.store, {
          id: awakeableId, ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, runId: ctx.runId,
          kind: 'wait', label: taskLabel(JSON.stringify(parsed.filter)), notify: true, chainId: spawn.chainId, generation,
          status: 'running', startedAt: nowIso(),
        }));
        // H-85: also schedule the expiry notice. Its id differs from the delivery's (Restate dedupes
        // sends by id); the Session drops it if the subscription was already consumed by an event.
        const expiry = expiryWake(ctx, awakeableId, expiresAt, generation);
        await ctx.step('schedule_expiry', async () => {
          await opts.enqueuer.enqueue(expiry, { delayMs: timeoutMs });
        });
        return { content: [{ type: 'text', text: `You will be woken with a task_done (id ${awakeableId}) when a matching event arrives, or when the wait expires (${expiresAt}).` }] };
      }
      return {
        content: [{ type: 'text', text: `Waiting for matching event (expires ${expiresAt})...` }],
        suspend: { reason: 'event', awakeableId, until: expiresAt },
      };
    },
  };
}

function parseTimeoutMs(timeoutStr: string | undefined): number {
  return timeoutStr === undefined ? 86_400_000 : durationMs(timeoutStr);
}

/** The timeout task_done for a notify subscription, delivered at its expiry unless an event consumed it first. */
function expiryWake(ctx: ToolContext, subscriptionId: string, expiresAt: string, generation: number): WakeEvent {
  return {
    id: subscriptionId + ':expired',
    ownerId: ctx.ownerId,
    agentId: ctx.agentId,
    sessionKey: sessionKey(ctx.agentId, ctx.conversationId),
    conversationId: ctx.conversationId,
    kind: 'task_done',
    origin: { type: 'system' },
    trusted: false,
    priority: 'background',
    payload: { taskId: subscriptionId, taskKind: 'event', status: 'timeout', summary: 'No matching event arrived before ' + expiresAt + '.', text: 'No matching event arrived before ' + expiresAt + '.', generation, originRunId: ctx.runId },
    ...(ctx.wake.hop === undefined ? {} : { hop: ctx.wake.hop }),
    at: expiresAt,
    status: 'accepted',
  };
}
