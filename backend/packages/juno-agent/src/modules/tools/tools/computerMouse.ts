/** computer.click / double_click / right_click / move — pointer actions on this agent's own screen. */

import { sentenceOf } from '../../../execution/harness/services/decision/approval-arg.js';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient, type ComputerClientProvider } from '../computer/client.js';
import { actionResult, computerFailure, APPROVAL_PROPERTY, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { reviewDetails, screenInputGate, type PurchaseReview } from '../computer/purchase.js';

const clickSchema = z.object({
  x: z.number(),
  y: z.number(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  confirm: z.string().optional(), approval: z.unknown().optional(), on: ON_SCHEMA,
});

/** `"Label" at (x, y)` when the gate's lookup named the control under the point, else `(x, y)`. */
function namedPoint(label: string | undefined, point: { x: number; y: number }): string {
  return label ? `${JSON.stringify(label)} at (${point.x}, ${point.y})` : `(${point.x}, ${point.y})`;
}

export function createComputerClickTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.click',
    description: '',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number', description: '' }, y: { type: 'number', description: '' }, button: { enum: ['left', 'right', 'middle'], description: '' }, ...APPROVAL_PROPERTY, ...ON_PROPERTY },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    // A click is a committed side effect: never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = clickSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        // A left click may press a browser button: the same final-purchase gate as browser.click.
        const seen: { label?: string; review?: PurchaseReview; probability?: number } = {};
        const refused = parsed.button === undefined || parsed.button === 'left'
          ? await screenInputGate(opts.computer, ctx, { tool: 'computer.click', confirm: sentenceOf(parsed), point: { x: parsed.x, y: parsed.y }, seen }, parsed.on)
          : null;
        if (refused !== null) return refused;
        await client.click(ctx.agentId, { x: parsed.x, y: parsed.y, ...(parsed.button ? { button: parsed.button } : {}) }, ctx.signal, parsed.on);
        return actionResult(`Clicked ${namedPoint(seen.label, parsed)}`, { x: parsed.x, y: parsed.y, ...reviewDetails(seen) });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

export function createComputerDoubleClickTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.double_click',
    description: '',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, ...APPROVAL_PROPERTY, ...ON_PROPERTY },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = clickSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const seen: { label?: string; review?: PurchaseReview; probability?: number } = {};
        const refused = await screenInputGate(opts.computer, ctx, { tool: 'computer.double_click', confirm: sentenceOf(parsed), point: { x: parsed.x, y: parsed.y }, seen }, parsed.on);
        if (refused !== null) return refused;
        // Method calls, not extracted references, so a `this`-bound client keeps its receiver.
        if (client.doubleClick) await client.doubleClick(ctx.agentId, { x: parsed.x, y: parsed.y }, ctx.signal, parsed.on);
        else await client.click(ctx.agentId, { x: parsed.x, y: parsed.y }, ctx.signal, parsed.on);
        return actionResult(`Double-clicked ${namedPoint(seen.label, parsed)}`, { x: parsed.x, y: parsed.y, ...reviewDetails(seen) });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

export function createComputerRightClickTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.right_click',
    description: '',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, ...ON_PROPERTY },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = clickSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        if (client.rightClick) await client.rightClick(ctx.agentId, { x: parsed.x, y: parsed.y, button: 'right' }, ctx.signal, parsed.on);
        else await client.click(ctx.agentId, { x: parsed.x, y: parsed.y, button: 'right' }, ctx.signal, parsed.on);
        return actionResult(`Right-clicked (${parsed.x}, ${parsed.y})`, { x: parsed.x, y: parsed.y });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

export function createComputerMoveTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.move',
    description: '',
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' }, ...ON_PROPERTY },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    // Moving the pointer changes hover state, so treat it as a side effect even though nothing is clicked.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = clickSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        if (client.move) await client.move(ctx.agentId, { x: parsed.x, y: parsed.y }, ctx.signal, parsed.on);
        else await client.click(ctx.agentId, { x: parsed.x, y: parsed.y }, ctx.signal, parsed.on);
        return actionResult(`Moved to (${parsed.x}, ${parsed.y})`, { x: parsed.x, y: parsed.y });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
