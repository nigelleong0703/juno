import { z } from 'zod';
import { createHash } from 'node:crypto';
import { parseUiDoc, uiDocSchema, uiDocToText, type UiDoc } from '@agent-desktop/public-contracts';
import { sessionKey, type Enqueuer, type Store, type Tool, type ToolContext, type ToolResult, type WakeEvent } from '../../../contracts/index.js';
import { readString } from '../../../execution/brain/social-read.js';
import { profileAudience } from '../../profile/index.js';
import { CHILD_BOUNDARY_REFUSAL, CHILD_QUESTION_REFUSAL, isChildRun, storeChildResult } from '../../tasks/childDelivery.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { newId, nowIso } from '../util.js';
import { replyOriginOf } from '../../channel-origin.js';
import { goalConversationId } from '../../goals/checkin.js';
import { deliverRoomText } from './roomDelivery.js';
import { storeUserRequest, userRequest } from './userRequest.js';

const sendMessageSchema = z.object({
  kind: z.enum(['text', 'attachment', 'question', 'secret_request']),
  text: z.string().optional(),
  // Validated by parseUiDoc so the model gets one readable line per problem, not a zod dump.
  ui: z.unknown().optional(),
  targetAgentIds: z.array(z.string()).optional(),
  conversationId: z.string().optional(),
  toOwner: z.boolean().optional(),
});

/** The model-facing JSON schema of a UiDoc, from the one zod source. */
const { $schema: _draft, ...UI_JSON_RAW } = z.toJSONSchema(uiDocSchema, { io: 'input', unrepresentable: 'any', reused: 'inline' });
// anyOf, not oneOf: some providers' function-schema subsets (Gemini, OpenAI strict) accept only anyOf; the zod parse stays exact.
const UI_JSON_SCHEMA = JSON.parse(JSON.stringify(UI_JSON_RAW).replaceAll('"oneOf":', '"anyOf":')) as typeof UI_JSON_RAW;

export function createSendMessageTool(opts: { store: Store; enqueuer: Enqueuer }): Tool {
  return {
    name: 'send_message',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        kind: { enum: ['text', 'attachment', 'question', 'secret_request'], description: '' },
        text: { type: 'string', description: '' },
        ui: { ...UI_JSON_SCHEMA, description: '' },
        targetAgentIds: { type: 'array', items: { type: 'string' }, description: '' },
        conversationId: { type: 'string', description: '' },
        toOwner: { type: 'boolean', description: '' },
      },
      required: ['kind'],
    },
    replay: 'never',
    sideEffect: true,
    async reconcile(args: unknown, ctx: ToolContext) {
      const parsed = sendMessageSchema.safeParse(args);
      if (!parsed.success || parsed.data.kind !== 'text' || parsed.data.toOwner === true || (parsed.data.targetAgentIds?.length ?? 0) > 0 || parsed.data.conversationId !== undefined || parsed.data.ui !== undefined) {
        return { status: 'unknown', reason: 'this message route has no exact local delivery receipt' };
      }
      if (!ctx.stepId || ctx.signal.aborted) return { status: 'failed', reason: 'the run was cancelled or its action identity is unavailable' };
      const markdown = parsed.data.text?.trim() ?? '';
      const run = await opts.store.get('runs', ctx.runId);
      if (isChildRun(run)) return { status: 'unknown', reason: 'silent child delivery is recorded on the child run, without a step-bound message receipt' };
      const receiptId = messageReceiptId(ctx.stepId);
      try {
        const receipt = await opts.store.get('items', receiptId);
        if (receipt === null) return { status: 'not_executed', evidence: 'The owner-scoped conversation store has no item with this action’s deterministic receipt id.' };
        if (receipt.type !== 'agent_message' || receipt.agentId !== ctx.agentId || receipt.runId !== ctx.runId || receipt.conversationId !== ctx.conversationId || receipt.markdown !== markdown) {
          return { status: 'unknown', reason: 'a receipt exists but does not match the owner, agent, run, conversation and exact message' };
        }
        return { status: 'succeeded', evidence: 'The owner-scoped conversation store contains the exact persisted message receipt.', result: { content: [{ type: 'text', text: markdown }], details: { deliveredText: markdown, deliveredConversationId: ctx.conversationId } } };
      } catch {
        return { status: 'failed', reason: 'the owner-scoped message receipt query failed' };
      }
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = sendMessageSchema.parse(args);
      const text = parsed.text?.trim() ?? '';
      const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
      // CT: the canonical stored run row decides delivery; a silent child never reaches a human.
      const child = isChildRun(await opts.store.get('runs', ctx.runId));
      if (parsed.toOwner === true && parsed.kind !== 'text') return fail('toOwner only applies to a text message (kind text).');

      if (parsed.kind === 'question') {
        if (child) return { content: [{ type: 'text', text: CHILD_QUESTION_REFUSAL }], isError: true };
        const checked = parsed.ui === undefined
          ? { ok: false as const, error: 'a question needs ui with exactly one interactive block: a choices block (pick one or several) or a fields block (non-secret input)' }
          : parseUiDoc(parsed.ui, 'question');
        if (!checked.ok) {
          return fail(`invalid question ui: ${checked.error}. Ask again with ui: { version: 1, title?, blocks: [...facts/items/notice for what is being decided..., one choices or fields block] }.`);
        }
        return askQuestion(opts.store, checked.doc, ctx);
      }

      if (parsed.kind === 'text') {
        let ui: UiDoc | undefined;
        if (parsed.ui !== undefined) {
          const checked = parseUiDoc(parsed.ui, 'message');
          if (!checked.ok) return fail(`invalid ui: ${checked.error}`);
          ui = checked.doc;
        }
        // Quick-reply buttons alone are not a bubble: they sit under the chat, and their text form
        // ("Replies: Yes / No") would read as a message of its own in the chat list and notifications.
        const repliesOnly = ui !== undefined && ui.blocks.every((block) => block.type === 'replies');
        // The bubble's markdown is the lead-in, or the card's text form when the agent gave none, so
        // notifications and the model's own transcript have readable text.
        const markdown = text.length > 0 ? text : ui === undefined || repliesOnly ? '' : uiDocToText(ui);
        // Reject blank text before any write: an empty bubble would still mark a delivery and silence
        // the useful final report without showing the user anything.
        if (markdown.length === 0 && !repliesOnly) return fail('message text required');
        const seen = ui === undefined ? markdown : text.length === 0 ? uiDocToText(ui) : `${markdown}\n\n${uiDocToText(ui)}`;
        const targets = parsed.targetAgentIds ?? [];
        const explicitRoom = parsed.conversationId;
        // CT FIRST: a silent child never routes anywhere. Any target or room param is refused
        // before delivery, so send_message cannot bypass the boundary with rooms or wakes.
        if (child) {
          if (targets.length > 0 || explicitRoom !== undefined || parsed.toOwner === true) {
            return { content: [{ type: 'text', text: CHILD_BOUNDARY_REFUSAL }], isError: true };
          }
          const stored = await storeChildResult(opts, { runId: ctx.runId, agentId: ctx.agentId, conversationId: ctx.conversationId, text: seen }, { state: { cancelled: false }, signal: ctx.signal });
          if (!stored) {
            return { content: [{ type: 'text', text: 'Error: the child result could not be stored on the run; nothing was delivered.' }], isError: true };
          }
          return { content: [{ type: 'text', text: seen }], details: { deliveredText: seen, deliveredConversationId: ctx.conversationId } };
        }
        // Private answer in a group: the owner's direct chat with this agent, never refused for being outside this room.
        if (parsed.toOwner === true) {
          if (targets.length > 0 || explicitRoom !== undefined) return fail('toOwner cannot be combined with conversationId or targetAgentIds.');
          return handOffToOwner(opts, markdown, ui, seen, ctx);
        }
        const targetConversation = explicitRoom ?? ctx.conversationId;
        // Any targeted post, or any explicit room id, goes through the validated room path
        // (membership/owner/workspace rechecked before any write; conversationId is room-only, so a
        // direct or peer id is refused). A plain message with no room and no targets stays the
        // current conversation's bubble.
        if (targets.length > 0 || explicitRoom !== undefined) {
          if (ui !== undefined) return fail('ui cards are only for the current conversation; send text to a room or agent.');
          const delivered = await deliverRoomText(opts, ctx, targetConversation, text, targets);
          if (!delivered.ok) return delivered.result;
          return {
            content: [{ type: 'text', text: delivered.value.markdown }],
            details: {
              deliveredText: delivered.value.markdown,
              deliveredConversationId: delivered.value.roomId,
              roomDelivery: { roomId: delivered.value.roomId, targets: delivered.value.queued },
            },
          };
        }
        await postMessage(opts.store, markdown, ui, ctx);
        // Mark the delivered bubble so the run loop never repeats this text in the final reply.
        return { content: [{ type: 'text', text: seen }], details: { deliveredText: markdown || seen, deliveredConversationId: ctx.conversationId } };
      }

      if (parsed.kind === 'attachment') {
        return {
          content: [{ type: 'text', text: 'Attachments cannot be posted with send_message; use the send_file tool to save the sandbox file to the owner library first.' }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: 'secret_request is not supported by send_message. For a password, card details or a one-time code a page needs, call request_secure_input with the field refs: the user types them straight into the page.' }],
        isError: true,
      };
    },
  };
}

/** The first line a notification or list row can show for a question card. */
function questionSummary(doc: UiDoc): string {
  const first = doc.title ?? uiDocToText(doc).split('\n').find((line) => line.trim().length > 0) ?? 'Question';
  return first.substring(0, 100);
}

async function askQuestion(store: Store, doc: UiDoc, ctx: ToolContext): Promise<ToolResult> {
  const request = userRequest(ctx, {
    kind: 'question',
    title: 'Agent Question',
    summary: questionSummary(doc),
    payload: { kind: 'question', ui: doc },
  });
  await storeUserRequest(store, ctx, request);
  return { content: [{ type: 'text', text: 'The question is shown to the user. Their answer will arrive as their next message: end your turn now and do not wait for it.' }] };
}

/**
 * A hand-off from a group to the private chat. The note goes to this agent's direct chat with its owner (the one goal check-ins use;
 * created when there is none), so it stays out of the group; it carries no channel reply origin and is never delivered to the platform
 * chat the run is in. Then the same agent is woken in that chat with the owner's original message: that run serves the owner alone, so
 * memory and files are available there, and its final reply is the answer. Group runs never read private memory (any tool result stays in
 * the group's history), which is why the answer is not given here. Only the owner's own message may start it: a stranger must not be
 * able to make the agent wake itself in the owner's chat.
 */
async function handOffToOwner(opts: { store: Store; enqueuer: Enqueuer }, markdown: string, ui: UiDoc | undefined, seen: string, ctx: ToolContext): Promise<ToolResult> {
  const { store } = opts;
  const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
  const agent = await store.get('agents', ctx.agentId);
  if (agent === null) return fail('this agent has no record, so there is no owner chat to send to.');
  const audience = await profileAudience(store, { agentId: ctx.agentId, conversationId: ctx.conversationId, wake: [ctx.wake] });
  if (audience.ownerOnly) return fail('this chat is already private to your owner, so there is nothing to hand over: answer here.');
  if (ctx.wake.origin.type !== 'user' || !ctx.wake.trusted || (ctx.wake.origin.id !== undefined && ctx.wake.origin.id !== audience.profileOwnerId)) {
    return fail('toOwner is only for a message from your owner. This one came from someone else, so nothing was sent; answer them here with what is safe for everyone in this chat.');
  }
  const source = await store.get('conversations', ctx.conversationId);
  const sourceChat = source === null ? undefined : readString(source, 'title');
  const originalText = typeof ctx.wake.payload['text'] === 'string' ? ctx.wake.payload['text'] : '';
  const note = markdown || seen;
  const conversationId = await ctx.step('send_message_to_owner', async () => {
    const chatId = await goalConversationId(store, ctx.ownerId, agent);
    const item = {
      id: newId('itm'),
      conversationId: chatId,
      type: 'agent_message' as const,
      agentId: ctx.agentId,
      runId: ctx.runId,
      markdown,
      citations: [],
      ...(ui === undefined ? {} : { ui }),
      at: nowIso(),
    };
    await store.put('items', item, { conversationId: chatId, runId: ctx.runId });
    await emitItemAdded(store, chatId, item);
    return chatId;
  });
  // One wake per tool call: the id is fixed by the call and the step is journaled, so a replay neither wakes twice nor re-asks.
  const woken = await ctx.step('send_message_to_owner_wake', async () => {
    const at = nowIso();
    const wake: WakeEvent = {
      id: `wake_private_handoff_${ctx.runId}_${ctx.stepId ?? ''}`,
      ownerId: ctx.ownerId,
      agentId: ctx.agentId,
      sessionKey: sessionKey(ctx.agentId, conversationId),
      conversationId,
      kind: 'private_handoff',
      origin: { type: 'system', id: ctx.conversationId, label: 'Private hand-off' },
      trusted: true,
      priority: 'user',
      payload: { text: originalText, note, sourceChat: sourceChat ?? 'a group chat', sourceConversationId: ctx.conversationId },
      at,
      status: 'accepted',
    };
    try {
      return await opts.enqueuer.enqueue(wake, { awaitDecision: true });
    } catch (error) {
      return { accepted: false, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  if (!woken.accepted) {
    return {
      content: [{ type: 'text', text: `Error: the note was sent privately, but waking your private chat failed${woken.reason === undefined ? '' : ` (${woken.reason})`}. In this conversation say only that you could not answer privately right now.` }],
      isError: true,
      details: { deliveredText: note, deliveredConversationId: conversationId },
    };
  }
  return {
    content: [{ type: 'text', text: "Handed to your private chat with your owner: the note is there and you'll answer there, where their memory and files are available. In this conversation say only that you'll answer privately; do not answer or repeat it here." }],
    details: { deliveredText: note, deliveredConversationId: conversationId },
  };
}

async function postMessage(store: Store, markdown: string, ui: UiDoc | undefined, ctx: ToolContext): Promise<void> {
  const replyTo = replyOriginOf([ctx.wake]);
  const item = {
    id: ctx.stepId === undefined ? newId('itm') : messageReceiptId(ctx.stepId),
    conversationId: ctx.conversationId,
    type: 'agent_message' as const,
    agentId: ctx.agentId,
    runId: ctx.runId,
    markdown,
    citations: [],
    ...(ui === undefined ? {} : { ui }),
    ...(replyTo === undefined ? {} : { replyTo }),
    at: nowIso(),
  };

  await ctx.step('send_message_text', async () => {
    await store.put('items', item, { conversationId: ctx.conversationId, runId: ctx.runId });
    await emitItemAdded(store, ctx.conversationId, item);
  });
}

/** Stable local receipt identity: a recovered send can be looked up without issuing it again. */
function messageReceiptId(stepId: string): string {
  return 'itm-recovery-' + createHash('sha256').update(stepId).digest('hex').slice(0, 32);
}
