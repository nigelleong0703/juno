/**
 * Trial run of a routine the agent started on its own (BACKEND §3.6.4). A routine made by a run nobody was waiting on (`ToolContext.sendOnly`)
 * is something the person did not ask for in that moment, so its runs only record what they WOULD have said or changed (a speaking tool or
 * an outside write) until the person answers one plain card: turn it on, or not. A routine the person asked for in the chat is never on trial.
 *
 * "Did the person ask for it" is not something the data can say (a tool call has no link to a request in the person's words), so the one rule
 * is the run's own origin: nobody was waiting on the run that made it.
 */
import type { Request, Routine } from '@agent-desktop/public-contracts';
import { withFallbackText } from '@agent-desktop/public-contracts';
import { COMPLETION_WAKE_KINDS, type Store, type StoredRequest, type Tool, type ToolResult, type WakeEvent, type WouldHave } from '../../../contracts/index.js';
import { emitAgentStatus } from '../../../execution/agent-status.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { resolveDeliveryConversation } from '../../../execution/harness/services/routineTimer-delivery.js';
import { words } from '../../mcp/tool-access.js';
import { newId, nowIso } from '../../tools/util.js';

export const PREVIEW_CHOICES_ID = 'preview';
export const PREVIEW_ON = 'on';
export const PREVIEW_OFF = 'off';

/** Tools that speak to someone (a person, a room, a peer, a feed). */
const SAYING_TOOLS: ReadonlySet<string> = new Set(['send_message', 'feed_post', 'post_to_room', 'message_agent', 'handoff', 'send_file']);
/** Own tools that publish or create something outside the run. */
const OUTSIDE_TOOLS: ReadonlySet<string> = new Set(['artifact_publish', 'space_publish', 'conversation_create']);

const MAX_WOULD_HAVE = 20;

/**
 * Whether a routine made by this run starts on trial: the run is one nobody waits on. `sendOnly` is the run's own mark, set when it starts
 * and cleared when a person writes into it, so a person who steers a routine run into making a routine has asked for it.
 */
export const startsOnTrial = (ctx: { sendOnly?: boolean }): boolean => ctx.sendOnly === true;

/** What kind of preview record a call is, or undefined when a preview run lets it through (reads, the agent's own notes, files in its home). */
export function previewKind(tool: Pick<Tool, 'name' | 'mcp' | 'origin'>): WouldHave['kind'] | undefined {
  if (SAYING_TOOLS.has(tool.name)) return 'say';
  if (OUTSIDE_TOOLS.has(tool.name)) return 'do';
  // A connected app's tool that changes something (the classifier's verdict); one that only reads runs.
  return tool.mcp === true && tool.origin?.access !== 'read' ? 'do' : undefined;
}

const clip = (value: string, max: number): string => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : line.slice(0, max - 1) + '…';
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One plain line for what the call would have done, in the words of the trial card ("本来会发 <this>"). */
export function describeWouldHave(tool: Pick<Tool, 'name' | 'mcp' | 'origin'>, args: Record<string, unknown>): string {
  switch (tool.name) {
    case 'send_message': return 'a message "' + clip(text(args['text']) || 'a card', 60) + '"';
    case 'feed_post': return 'a Feed post "' + clip(text(args['title']), 60) + '"';
    case 'post_to_room':
    case 'message_agent': return 'a message "' + clip(text(args['message']), 60) + '"';
    case 'handoff': return 'a handoff "' + clip(text(args['task']), 60) + '"';
    case 'send_file': return 'the file ' + clip(text(args['name']) || text(args['path']), 60);
    case 'artifact_publish':
    case 'space_publish': return 'a page "' + clip(text(args['title']), 60) + '"';
    case 'conversation_create': return 'a new group "' + clip(text(args['title']), 60) + '"';
    default: {
      if (tool.origin === undefined) return tool.name;
      const title = tool.origin.title !== undefined && tool.origin.title !== '' ? tool.origin.title : words(tool.origin.toolName).join(' ');
      return tool.origin.connectionName + ' · ' + title;
    }
  }
}

/** What the model is told when a preview run calls a tool it may not really use: nothing happened, and why. */
export const PREVIEW_NOTICE = 'Nothing was sent or changed. This is the first run of a routine you started on your own, so it only records what you would have done; the person sees a short summary and decides whether to turn the routine on. Carry on as if it had gone through, and end with a one-line record of what you would have done.';

/** The result a preview run gets instead of running the call; `details.previewed` marks the step as not run, not as failed. */
export const previewResult = (): ToolResult => ({ content: [{ type: 'text', text: PREVIEW_NOTICE }], details: { previewed: true } });

/**
 * If this run is on trial and the call is one it may not really make: record it on the run that started the work and return the result
 * the model gets instead. Null for every other call (and every other run).
 */
export async function previewRefusal(store: Store, runId: string, tool: Pick<Tool, 'name' | 'mcp' | 'origin'> | undefined, args: Record<string, unknown>): Promise<ToolResult | null> {
  const kind = tool === undefined ? undefined : previewKind(tool);
  if (tool === undefined || kind === undefined) return null;
  const run = await store.get('runs', runId);
  if (run?.preview !== true) return null;
  const entry: WouldHave = { tool: tool.name, kind, summary: describeWouldHave(tool, args), at: nowIso() };
  await store.tx(async (tx) => {
    const rootId = run.rootRunId ?? runId;
    const root = rootId === runId ? run : await tx.get('runs', rootId);
    if (root === null) return;
    await tx.patch('runs', rootId, { wouldHave: [...(root.wouldHave ?? []), entry].slice(0, MAX_WOULD_HAVE) });
  });
  return previewResult();
}

/** Whether the run a wake starts is on trial: it is a run of a routine that still is, or it continues a run that was (a child, a task's wrap-up). */
export async function previewOfWake(store: Store, wake: WakeEvent | undefined): Promise<boolean> {
  if (wake === undefined) return false;
  const continued = wake.kind === 'subagent_task' ? text(wake.payload['parentRunId']) : COMPLETION_WAKE_KINDS.includes(wake.kind) ? text(wake.payload['originRunId']) : '';
  if (continued !== '') return (await store.get('runs', continued))?.preview === true;
  if (wake.kind !== 'routine' && wake.kind !== 'webhook') return false;
  const routineId = text(wake.payload['routineId']) || (wake.origin.type === 'automation' ? wake.origin.id ?? '' : '');
  return routineId !== '' && (await store.get('routines', routineId))?.preview !== undefined;
}

/** The card's one sentence: what the first run would have done, with the rest counted. */
export function previewLine(routineName: string, wouldHave: readonly WouldHave[]): string {
  // English like every other system card the app shows; the agent's own words stay in the person's language.
  const name = routineName.replace(/\s+/g, ' ').trim() || 'This routine';
  const first = wouldHave[0];
  if (first === undefined) return 'Trial run of ' + name + ': nothing to send this time. Turn it on?';
  const more = wouldHave.length > 1 ? ' (and ' + String(wouldHave.length - 1) + ' more)' : '';
  return 'Trial run of ' + name + ': it would have ' + (first.kind === 'say' ? 'sent ' : 'done ') + first.summary + more + '. Turn it on?';
}

/**
 * After a trial run finished: the one card in the routine's chat asking whether to turn it on. At most one is open per routine (a routine
 * that stays on trial does not stack cards); nothing is raised when the routine is no longer on trial or has no chat to speak in.
 * The request id comes from the run, so a replayed step finds its own card.
 */
export async function raisePreviewCard(store: Store, routineId: string, ownerId: string, runId: string): Promise<string | undefined> {
  const routine = await store.get('routines', routineId);
  if (routine?.preview === undefined) return undefined;
  const run = await store.get('runs', runId);
  const id = 'req-preview-' + runId;
  if ((await store.get('requests', id)) !== null) return id;
  const open = routine.preview.requestId === undefined ? null : await store.get('requests', routine.preview.requestId);
  if (open?.status === 'pending') return undefined;
  const conversationId = await resolveDeliveryConversation(routine, store);
  if (conversationId === undefined) return undefined;
  const line = previewLine(routine.name, run?.wouldHave ?? []);
  const request: Request & { ownerId: string; previewQuestion: { routineId: string } } = {
    id, kind: 'question', status: 'pending', title: routine.name.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Trial run', summary: line,
    agentId: routine.agentId, conversationId, runId, ownerId, createdAt: nowIso(), previewQuestion: { routineId },
    payload: {
      kind: 'question',
      ui: withFallbackText({
        version: 1,
        blocks: [
          { type: 'text', text: line },
          { type: 'choices', id: PREVIEW_CHOICES_ID, options: [{ id: PREVIEW_ON, label: 'Turn on', style: 'primary' }, { id: PREVIEW_OFF, label: 'Not now' }] },
        ],
      }),
    },
  };
  await store.put('requests', request, { conversationId });
  const { previewQuestion: _held, ownerId: _owner, ...visible } = request;
  await store.emit({ type: 'request.created', request: visible });
  const item = { id: newId('itm'), conversationId, type: 'request' as const, requestId: id, at: nowIso() };
  await store.put('items', item, { conversationId });
  await emitItemAdded(store, conversationId, item);
  await emitAgentStatus(store, routine.agentId);
  await store.patch('routines', routineId, { preview: { requestId: id } });
  return id;
}

/**
 * A routine run finished: if it was a trial run, raise the card (once per open question) and return the line for the routine's history.
 * Any other run returns undefined.
 */
export async function finishTrialRun(store: Store, ownerId: string, routineId: string, runId: string): Promise<string | undefined> {
  const run = await store.get('runs', runId);
  if (run?.preview !== true) return undefined;
  await raisePreviewCard(store, routineId, ownerId, runId);
  const n = run.wouldHave?.length ?? 0;
  return n === 0 ? 'Trial run: nothing to send' : 'Trial run: ' + String(n) + (n === 1 ? ' thing' : ' things') + ' recorded, not done';
}

/** The routine is no longer on trial (the person decided); with `off` it is switched off too. Safe to repeat. */
export async function endPreview(store: Store, routineId: string, decision: 'on' | 'off'): Promise<Routine | undefined> {
  const routine = await store.get('routines', routineId);
  if (routine === null) return undefined;
  if (routine.preview === undefined && (decision === 'on' || !routine.enabled)) return routine;
  const updated = await store.patch('routines', routineId, decision === 'off' ? { preview: undefined, enabled: false } : { preview: undefined });
  await store.emit({ type: 'routine.updated', routine: updated });
  return updated;
}

/** The person answered the trial card: "Turn on" turns the routine on, "Not now" turns it off. A dismissed card changes nothing (the next trial run asks again). */
export async function settlePreviewQuestion(store: Store, request: StoredRequest): Promise<void> {
  const question = request.previewQuestion;
  if (question === undefined || request.status !== 'answered' || request.payload.kind !== 'question') return;
  const answer = request.payload.answers?.[PREVIEW_CHOICES_ID];
  if (answer === PREVIEW_ON || answer === PREVIEW_OFF) await endPreview(store, question.routineId, answer);
}
