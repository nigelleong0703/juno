/**
 * browser.dialog — answer the native JS dialog (confirm / prompt / beforeunload) blocking a tab of this agent's
 * Chromium. A plain alert() is accepted by the sandbox on its own (it only has OK) and reported in the next
 * result; the others may confirm something destructive, so the agent decides here, and accepting one whose
 * message commits a purchase or a permanent change needs `confirm`, like the final purchase button. A confirm or prompt whose
 * message is ambiguous ("Are you sure?") is put to the reviewer (judgeDialog); only PROCEED accepts without `confirm`.
 */

import { sentenceOf } from '../../../execution/harness/services/decision/approval-arg.js';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { ComputerError } from '../computer/contract.js';
import { computerFailure, APPROVAL_PROPERTY, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { judgeDialog, purchaseRefusal, reviewDetails, withNotices } from '../computer/purchase.js';
import { saveScreenPreview } from '../computer/preview.js';
import type { ComputerClientProvider } from '../computer/client.js';
import { runBrowser, withSnapshot } from './computerBrowserActions.js';

const schema = z.object({
  action: z.enum(['accept', 'dismiss']),
  text: z.string().max(2_000).optional(),
  tab: z.string().min(1).optional(),
  confirm: z.string().optional(), approval: z.unknown().optional(),
  on: ON_SCHEMA,
});

export function createBrowserDialogTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'browser.dialog',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        action: { enum: ['accept', 'dismiss'] },
        text: { type: 'string', description: '' },
        tab: { type: 'string', description: '' },
        ...APPROVAL_PROPERTY,
        ...ON_PROPERTY,
      },
      required: ['action'],
      additionalProperties: false,
    },
    // Answering a dialog commits whatever it asked: never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async approvalDetails(_args, ctx) {
      const parsed = schema.safeParse(_args);
      const preview = await saveScreenPreview(opts.computer, ctx, parsed.success ? parsed.data.on : undefined);
      return preview === undefined ? {} : { preview };
    },
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      const tab = parsed.tab === undefined ? {} : { tab: parsed.tab };
      try {
        const open = await runBrowser(opts.computer, ctx, { action: 'dialog', ...tab }, parsed.on);
        if (open.action !== 'dialog') throw new ComputerError('failed', `browser dialog returned a ${open.action} result`);
        if (open.dialog === undefined) {
          // Often an alert that was already accepted on its own: say so, the agent may be looking for it.
          return { content: [{ type: 'text', text: withNotices(`No dialog is open on tab ${open.tab}; nothing to answer.`, open) }], isError: true, details: { tab: open.tab, code: 'no_dialog' } };
        }
        const confirmed = sentenceOf(parsed) !== '';
        if (parsed.action === 'accept' && !confirmed) {
          const verdict = await judgeDialog(ctx, open.dialog, open.url, parsed.on);
          if (verdict.block) {
            return purchaseRefusal(`accepting the ${open.dialog.type} ${JSON.stringify(open.dialog.message)}`, 'Call browser.dialog again',
              { dialog: open.dialog, ...reviewDetails(verdict) });
          }
        }
        const page = await runBrowser(opts.computer, ctx, {
          action: 'dialog', ...tab, accept: parsed.action === 'accept', ...(parsed.text === undefined ? {} : { text: parsed.text }),
        }, parsed.on);
        if (page.action !== 'dialog') throw new ComputerError('failed', `browser dialog returned a ${page.action} result`);
        const answered = parsed.action === 'accept' ? 'Accepted' : 'Dismissed';
        // The read before the answer already took any other notices (alerts, popups): keep them in this result.
        const line = withNotices(`${answered} the ${open.dialog.type} dialog on tab ${page.tab}.`, { ...open, dialog: undefined });
        return await withSnapshot(opts.computer, ctx, line, { tab: page.tab, url: page.url, dialogType: open.dialog.type }, page, parsed.on);
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
