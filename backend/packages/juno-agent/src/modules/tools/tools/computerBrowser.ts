/** browser.navigate — point this agent's own Chromium at a URL. */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient, type ComputerClientProvider } from '../computer/client.js';
import { ComputerError } from '../computer/contract.js';
import { actionResult, computerFailure, noteBrowserRestart, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { withSnapshot } from './computerBrowserActions.js';
import { withNotices } from '../computer/purchase.js';

const schema = z.object({
  url: z.string().url().refine((url) => url.startsWith('http://') || url.startsWith('https://'), {
    message: 'url must be an http(s) URL',
  }),
  tab: z.string().min(1).optional(),
  on: ON_SCHEMA,
});

/** One line for a page the tool opened; a page still loading says so instead of claiming it loaded. */
export function pageLine(prefix: string, page: { url: string; title: string; loading?: true }, requested?: string): string {
  if (page.loading) return `${prefix} ${requested ?? page.url}: still loading after several seconds; take browser.snapshot in a moment instead of navigating again.`;
  return `${prefix} ${page.title ? `${page.title} (${page.url})` : page.url}`;
}

export function createBrowserNavigateTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'browser.navigate',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        tab: { type: 'string', description: '' },
        ...ON_PROPERTY,
      },
      required: ['url'],
      additionalProperties: false,
    },
    // Navigation has network side effects; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        if (!client.browser) {
          if (parsed.tab !== undefined) throw new ComputerError('unavailable', 'Tabs are not available: this deployment has no sandbox browser helper.');
          const page = await client.navigate(ctx.agentId, parsed.url, ctx.signal, parsed.on);
          return actionResult(`Navigated to ${page.title ? `${page.title} (${page.url})` : page.url}`, { url: page.url });
        }
        const page = await client.browser(ctx.agentId, { action: 'navigate', url: parsed.url, ...(parsed.tab === undefined ? {} : { tab: parsed.tab }) }, ctx.signal, parsed.on);
        noteBrowserRestart(ctx, page);
        if (page.action !== 'navigate') throw new ComputerError('failed', `browser navigate returned a ${page.action} result`);
        const line = pageLine(`Navigated tab ${page.tab} to`, page, parsed.url);
        // A page still loading has nothing useful to list yet; its line already says to snapshot in a moment.
        if (page.loading && page.dialog === undefined) return actionResult(withNotices(line, page), { tab: page.tab, url: page.url, loading: true });
        return await withSnapshot(opts.computer, ctx, line, { tab: page.tab, url: page.url }, page, parsed.on);
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
