// ask_about_uncertain_action: the one question the person gets about an outside action nobody can tell the outcome of (BACKEND §3.3d.5).
// The agent checks first (a read tool, its own judgement); only when it cannot tell AND doing the action twice would matter does it ask,
// in the person's words and language. The card carries the question and two buttons: nothing technical. The answer arrives as their next
// message, with a system note saying whether the action may be repeated once. The link to the fenced step stays on the request
// (`reconciliation`, internal) and in the step record.
import { z } from 'zod';
import { parseUiDoc, type UiDoc } from '@agent-desktop/public-contracts';
import { toPublicRequest, type Store, type StoredRequest, type Tool, type ToolContext, type ToolResult } from '../../../contracts/index.js';
import { recoveryRequestId } from '../../../execution/harness/services/recovery-ledger.js';
import { readExecution } from '../../../execution/harness/services/replay.js';
import { emitAgentStatus } from '../../../execution/agent-status.js';
import { emitItemAdded } from '../../../execution/conversation-activity.js';
import { openEffectReview } from '../../tasks/effect-review.js';
import { newId, nowIso } from '../util.js';

const schema = z.object({
  question: z.string().trim().min(1),
  redoLabel: z.string().trim().min(1).optional(),
  skipLabel: z.string().trim().min(1).optional(),
});

const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: 'Error: ' + message }], isError: true });

export function createAskAboutUncertainActionTool(opts: { store: Store }): Tool {
  const { store } = opts;
  return {
    name: 'ask_about_uncertain_action',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '' },
        redoLabel: { type: 'string', description: '' },
        skipLabel: { type: 'string', description: '' },
      },
      required: ['question'],
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      // The action this run was last told about (harness/services/uncertain-action.ts): the agent never names a step or an id.
      const run = await store.get('runs', ctx.runId);
      const stepId = run?.uncertainSteps?.at(-1);
      const step = stepId === undefined ? null : await store.get('steps', stepId);
      const intent = step === null ? undefined : readExecution(step)?.intent;
      if (step === null || intent === undefined) return fail('there is no uncertain action in this run to ask about. Ask only about an action you were told may or may not have happened.');
      const id = recoveryRequestId(step.id);
      if ((await store.get('requests', id)) !== null) return fail('the person was already asked about this action. Their answer will arrive as their next message: end your turn now.');
      const ui: UiDoc | undefined = (() => {
        const checked = parseUiDoc({
          version: 1,
          blocks: [
            { type: 'text', text: parsed.question },
            { type: 'choices', id: 'recovery_outcome', options: [
              { id: 'redo', label: parsed.redoLabel ?? 'Do it again', style: 'primary' },
              { id: 'skip', label: parsed.skipLabel ?? 'Leave it', style: 'default' },
            ] },
          ],
        }, 'question');
        return checked.ok ? checked.doc : undefined;
      })();
      if (ui === undefined) return fail('the question is too long or the button labels are not short plain text: ask in one or two sentences (at most 400 characters) with buttons of a few words.');
      const createdAt = nowIso();
      const request: StoredRequest = {
        id, kind: 'question', status: 'pending', title: 'Agent Question', summary: parsed.question.slice(0, 100),
        agentId: ctx.agentId, conversationId: ctx.conversationId, runId: ctx.runId,
        payload: { kind: 'question', ui },
        createdAt,
        // The run does not wait: the answer comes as the person's next message (routes/requests.ts), like any agent question.
        interrupted: true,
        reconciliation: { stepId: step.id, tool: intent.tool, fingerprint: intent.fingerprint, state: 'pending', ...(intent.connectionId === undefined ? {} : { connectionId: intent.connectionId }), ...(intent.account === undefined ? {} : { account: intent.account }) },
      };
      const item = { id: newId('itm'), conversationId: ctx.conversationId, type: 'request' as const, requestId: id, at: createdAt };
      await ctx.step('ask_about_uncertain_action', async () => {
        await store.tx(async (tx) => {
          await tx.put('requests', request, { conversationId: ctx.conversationId, runId: ctx.runId });
          await tx.put('items', item, { conversationId: ctx.conversationId });
          await tx.emit({ type: 'request.created', request: toPublicRequest(request) });
          await emitItemAdded(tx, ctx.conversationId, item);
          // The run now has an uncertain outside action the person has not settled: its task reads as waiting for the answer.
          await openEffectReview(tx, ctx.runId);
        });
        await emitAgentStatus(store, ctx.agentId);
      });
      return { content: [{ type: 'text', text: 'The question is shown to the person. Their answer will arrive as their next message: end your turn now and do not repeat the action meanwhile.' }] };
    },
  };
}
