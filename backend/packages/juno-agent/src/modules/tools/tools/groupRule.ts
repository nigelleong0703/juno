// group_rule: the owner's standing rule for a platform group ("in this group, always reply in English"), appended to the group's
// note under "Owner's rules" (BACKEND §5.7.9). Owner-only: it works only in a run the owner's own message woke (the same trust check
// as agent_update) and only in a platform group, and the note is written through the platform's home write path. Hidden behind tool_search.
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { replyOriginOf } from '../../channel-origin.js';
import { getRow } from '../../home/mirror.js';
import { editHomeFile } from '../../memory/files.js';
import { RULES_MAX, RULE_MAX_CHARS, groupChatOf, groupNotePath, groupNoteTitle, parseNote, plainBlock, renderNote, rulesOf, withRule, withWorkspace } from '../../groups/note.js';
import type { ComputerClientProvider } from '../computer/client.js';

const schema = z.object({ text: z.string().trim().min(1).max(RULE_MAX_CHARS * 2) }).strict();

const result = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) });

export function createGroupRuleTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'group_rule',
    description: '',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '' } },
      required: ['text'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!ctx.wake.trusted) return result("only your owner's own words can set a rule for a group. Tell the person you can't record it.", true);
      const parsed = schema.safeParse(args);
      if (!parsed.success) return invalidArguments('group_rule', args, parsed.error);
      const rule = plainBlock(parsed.data.text, RULE_MAX_CHARS * 2).replace(/\s*\n\s*/g, ' ').replace(/^[-*]\s+/, '');
      if (rule === '' || rule.length > RULE_MAX_CHARS) return result('the rule must be one short sentence of at most ' + String(RULE_MAX_CHARS) + ' characters.', true);
      const conversation = replyOriginOf([ctx.wake])?.chatType === 'group' ? await ctx.store.get('conversations', ctx.conversationId) : null;
      const base = conversation === null ? undefined : groupChatOf(conversation);
      if (conversation === null || base === undefined) return result('this is not a platform group chat, so there is no group note to add a rule to.', true);
      const path = groupNotePath(ctx.ownerId, await withWorkspace(ctx.store, ctx.ownerId, base));
      const client = opts.computer?.();
      return ctx.step('group_rule', async (): Promise<ToolResult> => {
        const outcome: { refused?: 'duplicate' | 'full' } = {};
        await editHomeFile({ store: ctx.store, ...(client?.home === undefined ? {} : { home: client.home }) }, { ownerId: ctx.ownerId, agentId: ctx.agentId, path }, (content) => {
          const doc = parseNote(content);
          const next = withRule({ ...doc, title: doc.title === '' ? groupNoteTitle(conversation) : doc.title }, rule);
          if ('refused' in next) {
            outcome.refused = next.refused;
            return null;
          }
          return renderNote(next.doc);
        });
        if (outcome.refused === 'duplicate') return result('that rule is already recorded for this group.');
        if (outcome.refused === 'full') return result('this group already has ' + String(RULES_MAX) + ' rules. Ask your owner to remove some in Memory (the group note), then try again.', true);
        const saved = parseNote((await getRow(ctx.store, ctx.ownerId, path))?.content ?? '');
        return result('Recorded for this group: ' + rule + ' (' + String(rulesOf(saved).length) + ' rule(s) now).');
      });
    },
  };
}
