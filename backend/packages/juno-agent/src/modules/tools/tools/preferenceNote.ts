// preference_note: records a rule the owner just stated about what the agent may message them about unprompted ("stop telling me about X",
// "put that in the Feed"), into their proactive rules (BACKEND §5.10). Only from the owner's own words: the run must be woken by the owner's
// message in a direct chat, and `quote` must appear in an owner message of this conversation or the rule is refused. The rule line carries the quote
// as its source. Hidden behind tool_search.
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import { proactiveRuleKindSchema, proactiveRuleScopeSchema } from '@agent-desktop/public-contracts';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { recordRule } from '../../proactive/service.js';
import type { ComputerClientProvider } from '../computer/client.js';

const MAX_RULE_CHARS = 200;
const MAX_QUOTE_CHARS = 300;
/** Owner messages of this chat a quote is looked for in (the newest first). */
const QUOTE_WINDOW = 60;

const schema = z.object({
  kind: proactiveRuleKindSchema,
  scope: proactiveRuleScopeSchema,
  rule: z.string().trim().min(1).max(MAX_RULE_CHARS),
  quote: z.string().trim().min(3).max(MAX_QUOTE_CHARS),
}).strict();

const result = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) });
/** Whitespace and case never make a genuine quote fail the check. */
const norm = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Whether `quote` is inside a message the owner wrote in this conversation. */
async function saidByOwner(ctx: ToolContext, quote: string): Promise<boolean> {
  const wanted = norm(quote);
  const page = await ctx.store.list('items', { where: { conversationId: ctx.conversationId }, orderBy: 'at', order: 'desc', limit: QUOTE_WINDOW });
  return page.items.some((item) => item.type === 'user_message' && item.authorId === ctx.ownerId && norm(item.text).includes(wanted));
}

export function createPreferenceNoteTool(opts: { computer?: ComputerClientProvider; now?: () => Date }): Tool {
  return {
    name: 'preference_note',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tell', 'dont', 'less', 'where'], description: '' },
        scope: { type: 'string', enum: ['topic', 'type', 'frequency'] },
        rule: { type: 'string', description: '' },
        quote: { type: 'string', description: '' },
      },
      required: ['kind', 'scope', 'rule', 'quote'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (ctx.wake.kind === 'child_task') return result('a sub-task cannot record preferences; tell the agent that started you.', true);
      if (!ctx.wake.trusted || ctx.wake.kind !== 'user_message') return result("preferences are recorded only in a run your owner's own message started. Tell the person you cannot record it from here.", true);
      const parsed = schema.safeParse(args);
      if (!parsed.success) return invalidArguments('preference_note', args, parsed.error);
      const conversation = await ctx.store.get('conversations', ctx.conversationId);
      if (conversation === null || conversation.kind !== 'direct') return result('preferences are recorded only in your private chat with your owner, not in a group or shared chat.', true);
      if (!(await saidByOwner(ctx, parsed.data.quote))) return result('refused: that quote is not in a message your owner wrote in this chat. Quote their exact words, or do not record it.', true);
      const { kind, scope, rule, quote } = parsed.data;
      const client = opts.computer?.();
      return ctx.step('preference_note', async (): Promise<ToolResult> => {
        const saved = await recordRule({ store: ctx.store, ...(client?.home === undefined ? {} : { home: client.home }) }, ctx.ownerId, { kind, scope, text: rule, source: 'You said "' + quote + '"' }, (opts.now ?? (() => new Date()))());
        return result((saved.added ? 'Recorded: ' : 'Already recorded: ') + saved.rule.text + ' (' + saved.rule.kind + ', ' + saved.rule.scope + '). Your owner sees it in their proactive rules and can delete it.');
      });
    },
  };
}
