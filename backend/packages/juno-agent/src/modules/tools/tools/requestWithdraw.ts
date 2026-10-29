/**
 * request_withdraw: the agent closes its own still-open request (approval, sign-in, take-over, secure input) when the user
 * changed their plan by typing instead of deciding. The request ends `expired` (shown as cancelled); only the model decides this.
 */
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import { patchWhen, type Store, type Tool, type ToolContext, type ToolResult } from '../../../contracts/index.js';
import { toPublicRequest, type StoredRequest } from '../../../contracts/requests.js';
import { emitAgentStatus } from '../../../execution/agent-status.js';
import { nowIso } from '../util.js';

const schema = z.object({ requestId: z.string().min(1).optional(), reason: z.string().trim().min(1).max(300).optional() });

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

export function createRequestWithdrawTool(opts: { store: Store }): Tool {
  return {
    name: 'request_withdraw',
    description: '',
    parameters: { type: 'object', properties: { requestId: { type: 'string', description: '' }, reason: { type: 'string', description: '' } } },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return invalidArguments('request_withdraw', args, parsed.error);
      const { store } = opts;
      const open = await store.list('requests', { where: { runId: ctx.runId, status: 'pending' }, limit: 20 });
      const mine = open.items.filter((request) => request.agentId === ctx.agentId && request.conversationId === ctx.conversationId && request.kind !== 'question');
      const target = parsed.data.requestId === undefined ? mine[0] : mine.find((request) => request.id === parsed.data.requestId);
      if (target === undefined) return text('Error: no open request of yours in this run' + (parsed.data.requestId === undefined ? '' : ' with that id'), true);
      const withdrawn = await ctx.step('withdraw_request', async () => {
        const at = nowIso();
        // The public decision already carries this: reason `cancelled` plus the note; clients show "Withdrawn in chat: <note>".
        const patch: Partial<StoredRequest> = { status: 'expired', resolvedAt: at, awakeableId: '', decision: { by: ctx.agentId, at, mode: 'auto', scope: 'once', reason: 'cancelled', ...(parsed.data.reason === undefined ? {} : { note: parsed.data.reason }) } };
        // The user may have decided in the meantime (from the coordinator): then that decision stands.
        const closed = await patchWhen(store, 'requests', target.id, (current) => current.status === 'pending', patch);
        if (closed === undefined) return false;
        await store.emit({ type: 'request.resolved', request: toPublicRequest(closed) });
        await emitAgentStatus(store, closed.agentId);
        return true;
      });
      if (!withdrawn) return text(`Not withdrawn: "${target.title}" was already decided by the user.`, true);
      return text(`Withdrawn: "${target.title}" is closed. Follow the user's message now.`);
    },
  };
}
