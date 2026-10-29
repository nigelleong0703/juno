import { z } from 'zod';
import { readOwnerTimeZone } from '../../../execution/brain/context.js';
import { Cron } from 'croner';
import type { Enqueuer, Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import type { RoutineTrigger } from '@agent-desktop/public-contracts';
import { newId, nowIso } from '../util.js';
import { readStringArray, requireRequesterContext } from './relationPolicy.js';
import { routineIntervalRefusal } from '../../tasks/routines/interval.js';
import { missingRequirements, parseRequires } from '../../tasks/routines/capabilities.js';
import { haveForOwner, raiseConnectRequest } from '../../tasks/routines/capability-gate.js';
import type { RunCapabilities } from '../../tasks/routines/runNote.js';

const stateUpdateSchema = z.object({
  target: z.enum(['routine']),
  action: z.enum(['create']),
  schedule: z.string().optional(),
  name: z.string().optional(),
  prompt: z.string().optional(),
  requires: z.unknown().optional(),
});

type StateUpdateArgs = z.infer<typeof stateUpdateSchema>;

interface StateUpdateOptions {
  store: Store;
  enqueuer: Enqueuer;
  /** What the platform offers (web search, a computer); checked against `requires`. Absent = neither. */
  capabilities?: RunCapabilities;
  /** Whether an agent can use the owner's Mac now; `mac` in `requires` is met by it. */
  macUsable?: (agentId: string) => Promise<boolean>;
}

export function createStateUpdateTool(opts: StateUpdateOptions): Tool {
  return {
    name: 'state_update',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        target: { enum: ['routine'] },
        action: { enum: ['create'] },
        name: { type: 'string' },
        prompt: { type: 'string' },
        schedule: { type: 'string' },
        requires: { type: 'array', description: '', items: {} },
      },
      required: ['target', 'action'],
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      return createRoutine(opts, stateUpdateSchema.parse(args), ctx);
    },
  };
}

async function createRoutine(opts: StateUpdateOptions, parsed: StateUpdateArgs, ctx: ToolContext): Promise<ToolResult> {
  // What a monitor found is data from outside; a run it started must not set up more automation.
  if (ctx.wake.kind === 'monitor') {
    return { content: [{ type: 'text', text: 'A run started by a monitor cannot create routines or monitors. Tell the person in your reply, and they can ask you in chat.' }], isError: true };
  }
  const schedule = parsed.schedule;
  const scheduleError = schedule ? cronError(schedule) : null;
  if (scheduleError) {
    return {
      content: [{ type: 'text', text: `Invalid schedule: ${scheduleError}` }],
      isError: true,
    };
  }

  if (ctx.conversationId.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: missing conversation context; routine delivery requires the current chat.' }],
      isError: true,
    };
  }
  const auth = await requireRequesterContext(ctx);
  if (!auth.ok) {
    return { content: [{ type: 'text', text: auth.error }], isError: true };
  }
  const membershipError = await routineConversationError(opts.store, ctx, auth.value.ownerId);
  if (membershipError !== undefined) {
    return { content: [{ type: 'text', text: membershipError }], isError: true };
  }
  const routineId = newId('rtn');
  // A cron the agent writes means the user's local time ("every day at 9"), not the server's.
  const trigger = routineTrigger(schedule, routineId, (await readOwnerTimeZone(opts.store, auth.value.ownerId)) ?? 'UTC');
  const tooFrequent = routineIntervalRefusal(trigger);
  if (tooFrequent !== undefined) return { content: [{ type: 'text', text: tooFrequent }], isError: true };
  const parsedRequires = parseRequires(parsed.requires);
  if (!parsedRequires.ok) return { content: [{ type: 'text', text: parsedRequires.error }], isError: true };
  const requires = parsedRequires.requires;
  const have = requires.length === 0 ? undefined : await haveForOwner({ store: opts.store, capabilities: opts.capabilities ?? { webSearch: false, computer: false }, ...(opts.macUsable ? { macUsable: opts.macUsable } : {}) }, auth.value.ownerId, ctx.agentId);
  const missing = have === undefined ? [] : missingRequirements(requires, have);
  const routine = {
    id: routineId,
    ownerId: auth.value.ownerId,
    agentId: ctx.agentId,
    name: parsed.name || 'Untitled',
    instructions: parsed.prompt || '',
    trigger,
    delivery: { channel: 'chat' as const, target: ctx.conversationId },
    notify: { mode: 'always' as const },
    enabled: true,
    status: missing.length > 0 ? ('needs_setup' as const) : ('active' as const),
    ...(requires.length === 0 ? {} : { requires }),
    ...(missing.length === 0 ? {} : { missing }),
    runs: [],
    createdAt: nowIso(),
  };

  await ctx.step('create_routine', async () => {
    await opts.store.put('routines', routine);
    await opts.store.emit({ type: 'routine.updated', routine });
    await opts.enqueuer.scheduleRoutine(routineId);
    if (missing.length > 0) await raiseConnectRequest(opts.store, routine, auth.value.ownerId, missing, have);
  });

  const webhookNote = routine.trigger.kind === 'webhook'
    ? '. It runs when its webhook is called. The user gets the webhook URL and secret from the routine settings; the secret is never shown to you, so do not ask for it or invent one.'
    : '';
  if (missing.length > 0) {
    const need = missing.map((item) => item.label).join('; and ');
    return {
      content: [{ type: 'text', text: `Routine created: ${routineId}, but it is on hold (needs_setup) because the user has not connected: ${need}. It will not run until they do. A Connect card was added to this chat. Tell the user in your reply exactly what to connect (${need}); do not do the routine's work yourself and do not pretend it is running. You will be told when it is connected.` }],
    };
  }
  return {
    content: [{ type: 'text', text: `Routine created: ${routineId}${webhookNote}` }],
  };
}

export async function routineConversationError(
  store: Store,
  ctx: ToolContext,
  ownerId: string,
): Promise<string | undefined> {
  let conversation: unknown;
  try {
    conversation = await store.get('conversations', ctx.conversationId);
  } catch {
    return 'Error: the current conversation record is unreadable; routine delivery is denied.';
  }
  if (conversation === null) return 'Error: the current conversation does not exist; routine delivery is denied.';
  const agentIds = readStringArray(conversation, 'agentIds') ?? [];
  if (!agentIds.includes(ctx.agentId)) {
    return 'Error: the current agent is not a member of this conversation; routine delivery is denied.';
  }
  const memberIds = readStringArray(conversation, 'memberIds') ?? [];
  if (!memberIds.includes(ownerId)) {
    return 'Error: the requester is not a member of this conversation; routine delivery is denied.';
  }
  return undefined;
}

/** A webhook routine starts with its relative hook path and no secret; the user issues the secret from the routine settings. */
function routineTrigger(schedule: string | undefined, routineId: string, tz: string): RoutineTrigger {
  if (schedule) {
    return { kind: 'schedule', cron: schedule, human: schedule, tz };
  }
  return { kind: 'webhook', url: '/v1/hooks/' + routineId, secretMasked: '' };
}

function cronError(schedule: string): string | null {
  try {
    new Cron(schedule);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
