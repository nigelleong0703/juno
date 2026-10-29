/** Scroll the observed Chrome area using pinned upstream geometry and the owned helper. */
import { z } from 'zod';
import type { Tool } from '../../../contracts/index.js';
import type { ComputerClientProvider } from '../computer/client.js';
import { ON_SCHEMA, ON_PROPERTY, computerFailure } from '../computer/shared.js';
import { runBrowser } from './computerBrowserActions.js';
const input = z.object({ tab: z.string().optional(), ref: z.string().optional(), direction: z.enum(['up', 'down']).optional(), on: ON_SCHEMA });
export function createBrowserScrollTool(opts: { computer?: ComputerClientProvider }): Tool {
  return { name: 'browser.scroll', description: '',
    parameters: { type: 'object', properties: { tab: { type: 'string' }, ref: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down'] }, ...ON_PROPERTY }, additionalProperties: false },
    sideEffect: true, replay: 'never', async execute(args, ctx) {
      const { on, ...parsed } = input.parse(args);
      try {
        const out = await runBrowser(opts.computer, ctx, { action: 'scroll', ...parsed }, on);
        if (out.action !== 'scroll') throw new Error('Unexpected scroll result');
        return { content: [{ type: 'text', text: JSON.stringify({ scrolled: out.scrolled, tab: out.tab, url: out.url }) }], details: { ...out } };
      } catch (error) { return computerFailure(error, ctx.signal); }
    } };
}
