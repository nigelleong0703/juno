/** computer.screenshot — a read-only look at this agent's own screen (BACKEND §4.2, §3.8). */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient, type ComputerClientProvider } from '../computer/client.js';
import { computerFailure, ON_PROPERTY, ON_SCHEMA, screenshotResult } from '../computer/shared.js';
import { noticeLines } from '../computer/purchase.js';

const schema = z.object({ on: ON_SCHEMA });

export function createComputerScreenshotTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.screenshot',
    description: '',
    parameters: { type: 'object', properties: { ...ON_PROPERTY }, additionalProperties: false },
    // Geometry may have moved since the last look; a fresh capture is the safe re-observation.
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        // Alongside, what the browser did meanwhile: an alert that was accepted on its own (a screenshot
        // taken after it no longer shows it), a dialog blocking a tab, a popup. Never fails the screenshot.
        const [shot, browser] = await Promise.all([
          client.screenshot(ctx.agentId, ctx.signal, parsed.on),
          client.browser?.(ctx.agentId, { action: 'notices' }, ctx.signal, parsed.on).catch(() => undefined),
        ]);
        const result = screenshotResult(shot);
        const lines = browser?.action === 'notices' ? noticeLines(browser) : [];
        return lines.length === 0 ? result : { ...result, content: [...result.content, { type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
