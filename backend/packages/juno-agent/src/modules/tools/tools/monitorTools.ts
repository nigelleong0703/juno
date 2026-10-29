/**
 * monitor_create / monitor_manage: the agent's own watches (BACKEND 3.6.3). A monitor is a routine with a `check` trigger: the
 * server makes one read-only tool call every so often and wakes the agent only when something new matches. Only the person
 * the agent works for can ask for one, in a live message: never a routine, a monitor, another agent or a stranger.
 */
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { CheckTrigger, Routine } from '@agent-desktop/public-contracts';
import type { Enqueuer, Store, Tool, ToolContext, ToolRegistry, ToolResult } from '../../../contracts/index.js';
import { listAll } from '../../memory/util.js';
import { runCheck, type CheckDeps } from '../../tasks/routines/monitor-check.js';
import { MONITOR_LIFETIME_DAYS, MONITOR_MAX_ACTIVE, minMonitorIntervalMs, specProblem } from '../../tasks/routines/monitor.js';
import { newId, nowIso } from '../util.js';
import { offeredIn } from '../scope.js';
import { requireRequesterContext } from './relationPolicy.js';
import { routineConversationError } from './stateUpdate.js';

interface MonitorToolOptions {
  store: Store;
  enqueuer: Enqueuer;
  /** Every tool the agent can use, to find the one to watch with. */
  tools: Pick<ToolRegistry, 'forAgent'>;
}

const DAY_MS = 86_400_000;

const createSchema = z.object({
  name: z.string().min(1).max(120),
  prompt: z.string().max(2000).optional(),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  items: z.string().optional(),
  id: z.string().optional(),
  pattern: z.string().optional(),
  below: z.number().optional(),
  everyMinutes: z.number().positive().optional(),
});

const manageSchema = z.object({
  action: z.enum(['list', 'pause', 'resume', 'renew', 'stop']),
  id: z.string().optional(),
});

const text = (value: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

/** A monitor is for the person the agent works for, asked live: not a routine or monitor run, another agent, or a stranger. */
function notOwnerRefusal(ctx: ToolContext): string | undefined {
  return ctx.wake.trusted && ctx.wake.origin.type === 'user' && ctx.wake.kind !== 'monitor'
    ? undefined
    : 'Only the person you work for can ask for a monitor, in a message they send you. A routine, a monitor run, another agent or someone else in a chat cannot.';
}

function every(minutes: number): string {
  if (minutes < 1) return 'Every ' + String(Math.max(1, Math.round(minutes * 60))) + ' seconds';
  if (minutes >= 60 && minutes % 60 === 0) return 'Every ' + String(minutes / 60) + (minutes === 60 ? ' hour' : ' hours');
  return 'Every ' + String(Math.round(minutes)) + ' minutes';
}

export function createMonitorCreateTool(opts: MonitorToolOptions): Tool {
  return {
    name: 'monitor_create',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '' },
        prompt: { type: 'string', description: '' },
        tool: { type: 'string', description: '' },
        args: { type: 'object', description: '' },
        items: { type: 'string', description: '' },
        id: { type: 'string', description: '' },
        pattern: { type: 'string', description: '' },
        below: { type: 'number', description: '' },
        everyMinutes: { type: 'number', description: '' },
      },
      required: ['name', 'tool'],
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const refusal = notOwnerRefusal(ctx);
      if (refusal !== undefined) return text(refusal, true);
      const parsed = createSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('monitor_create', args, parsed.error);
      const input = parsed.data;
      const minutes = input.everyMinutes ?? 30;
      if (minutes * 60_000 < minMonitorIntervalMs()) return text('A monitor checks at most every ' + String(Math.round(minMonitorIntervalMs() / 60_000)) + ' minutes; use a longer everyMinutes.', true);
      if (ctx.conversationId.length === 0) return text('Error: a monitor reports into the current chat, and there is none.', true);
      const auth = await requireRequesterContext(ctx);
      if (!auth.ok) return text(auth.error, true);
      const membership = await routineConversationError(opts.store, ctx, auth.value.ownerId);
      if (membership !== undefined) return text(membership, true);
      const trigger: CheckTrigger = {
        kind: 'check', everyMinutes: minutes, human: every(minutes), tool: input.tool, args: input.args ?? {},
        ...(input.items === undefined ? {} : { items: input.items }),
        ...(input.id === undefined ? {} : { id: input.id }),
        ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
        ...(input.below === undefined ? {} : { below: input.below }),
      };
      const problem = specProblem(trigger);
      if (problem !== undefined) return text('The monitor spec cannot work: ' + problem + '. Nothing was created.', true);
      const active = (await listAll(opts.store, 'routines')).filter((routine) => routine.trigger.kind === 'check' && routine.enabled);
      if (active.length >= MONITOR_MAX_ACTIVE) return text('You already have ' + String(active.length) + ' active monitors, the most there can be. Ask the person which one to stop (monitor_manage), then try again.', true);

      // A monitor reports into this chat, so it can watch only a tool this chat is offered (batch 5b): in a group, no connected app.
      const deps: CheckDeps = {
        store: ctx.store, blobs: ctx.blobs, enqueuer: ctx.enqueuer,
        tools: { forAgent: async (agentId, options) => offeredIn(ctx.toolScope, await opts.tools.forAgent(agentId, options)) },
      };
      const made = await ctx.step('monitor_create', async () => {
        const first = await runCheck(deps, { ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, routineId: 'new' }, trigger, []);
        if (!first.ok) return { ok: false as const, error: first.error };
        const routineId = newId('rtn');
        const now = nowIso();
        const routine: Routine & { ownerId: string } = {
          id: routineId, ownerId: auth.value.ownerId, agentId: ctx.agentId, name: input.name, instructions: input.prompt ?? '', trigger,
          delivery: { channel: 'chat', target: ctx.conversationId }, notify: { mode: 'always' }, enabled: true, status: 'active',
          monitor: { expiresAt: new Date(Date.now() + MONITOR_LIFETIME_DAYS * DAY_MS).toISOString(), lastCheckedAt: now, failures: 0 },
          runs: [], createdAt: now,
        };
        await opts.store.put('monitorState', { id: routineId, agentId: ctx.agentId, seen: first.currentIds, failures: 0, updatedAt: now });
        await opts.store.put('routines', routine);
        await opts.store.emit({ type: 'routine.updated', routine });
        await opts.enqueuer.scheduleRoutine(routineId);
        return { ok: true as const, id: routineId, existing: first.currentIds.length };
      });
      if (!made.ok) return text('The test check failed, so no monitor was created: ' + made.error + '. Fix the tool, its arguments or the items/id/pattern fields and try again.', true);
      return text(
        `Monitor created: ${made.id} ("${input.name}"). ${trigger.human.toLowerCase()}. The first look found ${String(made.existing)} item(s) that already match; they are recorded as seen and will never wake you. ` +
        'From now on you are woken only when something new matches, and your final reply then is posted in this chat. It stops after ' + String(MONITOR_LIFETIME_DAYS) + ' days and you will ask the person to renew. Tell the person what you are watching and how often.',
      );
    },
  };
}

function describeMonitor(routine: Routine): string {
  const view = routine.monitor;
  const trigger = routine.trigger;
  const state = view?.stoppedReason !== undefined ? 'stopped (' + view.stoppedReason + ')' : routine.enabled ? (view?.needsReconnect === true ? 'needs reconnect' : 'active') : 'paused';
  return `- ${routine.id} "${routine.name}": ${trigger.kind === 'check' ? trigger.human.toLowerCase() : ''}, ${state}, last checked ${view?.lastCheckedAt ?? 'never'}, last match ${view?.lastMatchAt ?? 'never'}, expires ${view?.expiresAt ?? 'unknown'}`;
}

export function createMonitorManageTool(opts: Pick<MonitorToolOptions, 'store' | 'enqueuer'>): Tool {
  return {
    name: 'monitor_manage',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        action: { enum: ['list', 'pause', 'resume', 'renew', 'stop'] },
        id: { type: 'string', description: '' },
      },
      required: ['action'],
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const refusal = notOwnerRefusal(ctx);
      if (refusal !== undefined) return text(refusal, true);
      const parsed = manageSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('monitor_manage', args, parsed.error);
      const { action, id } = parsed.data;
      const monitors = (await listAll(opts.store, 'routines')).filter((routine) => routine.trigger.kind === 'check' && routine.agentId === ctx.agentId);
      if (action === 'list') return text(monitors.length === 0 ? 'You have no monitors.' : monitors.map(describeMonitor).join('\n'));
      const routine = monitors.find((candidate) => candidate.id === id);
      if (routine === undefined) return text(`No monitor ${id ?? '(no id given)'} of yours. Use action "list" to see them.`, true);
      await ctx.step('monitor_manage_' + action, async () => {
        if (action === 'stop') {
          await opts.store.delete('monitorState', routine.id);
          await opts.store.delete('routines', routine.id);
          return;
        }
        const view = routine.monitor;
        const patch: Partial<Routine> = action === 'pause'
          ? { enabled: false, status: 'paused' }
          : action === 'resume'
            ? { enabled: true, status: 'active' }
            : {
              enabled: true, status: 'active',
              ...(view === undefined ? {} : { monitor: { expiresAt: new Date(Date.now() + MONITOR_LIFETIME_DAYS * DAY_MS).toISOString(), failures: view.failures, ...(view.lastCheckedAt === undefined ? {} : { lastCheckedAt: view.lastCheckedAt }), ...(view.lastMatchAt === undefined ? {} : { lastMatchAt: view.lastMatchAt }) } }),
            };
        const updated = await opts.store.patch('routines', routine.id, patch);
        await opts.store.emit({ type: 'routine.updated', routine: updated });
        await opts.enqueuer.scheduleRoutine(routine.id);
      });
      return text(`Monitor ${routine.id} ("${routine.name}"): ${action === 'stop' ? 'stopped and deleted' : action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'renewed for ' + String(MONITOR_LIFETIME_DAYS) + ' days'}.`);
    },
  };
}
