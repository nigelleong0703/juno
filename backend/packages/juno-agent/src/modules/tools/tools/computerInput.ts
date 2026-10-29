/** computer.type / computer.key / computer.scroll — keyboard and wheel input on this agent's own screen. */

import { sentenceOf } from '../../../execution/harness/services/decision/approval-arg.js';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient, type ComputerClientProvider } from '../computer/client.js';
import { actionResult, computerFailure, APPROVAL_PROPERTY, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { screenInputGate } from '../computer/purchase.js';

const typeSchema = z.object({ text: z.string().min(1), confirm: z.string().optional(), approval: z.unknown().optional(), on: ON_SCHEMA });
const keySchema = z.object({ key: z.string().min(1), confirm: z.string().optional(), approval: z.unknown().optional(), on: ON_SCHEMA });

/** Keys that press the focused control (a focused "Place order" button submits on Enter or Space). */
const PRESS_KEY = /^(return|enter|kp_enter|space)$/i;
const scrollSchema = z.object({ deltaY: z.number(), deltaX: z.number().optional(), on: ON_SCHEMA });

export function createComputerTypeTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.type',
    description: '',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '' }, ...APPROVAL_PROPERTY, ...ON_PROPERTY },
      required: ['text'],
      additionalProperties: false,
    },
    // Typing can submit a form or send a message; never replay it.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = typeSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        // A newline is a Return key press on the focused control: gated like computer.key Return.
        const refused = parsed.text.includes('\n') ? await screenInputGate(opts.computer, ctx, { tool: 'computer.type', confirm: sentenceOf(parsed) }, parsed.on) : null;
        if (refused !== null) return refused;
        await client.type(ctx.agentId, parsed.text, ctx.signal, parsed.on);
        return actionResult(`Typed ${parsed.text.length} character(s)`, { characters: parsed.text.length });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

export function createComputerKeyTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.key',
    description: '',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' }, ...APPROVAL_PROPERTY, ...ON_PROPERTY },
      required: ['key'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = keySchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const refused = PRESS_KEY.test(parsed.key.trim()) ? await screenInputGate(opts.computer, ctx, { tool: 'computer.key', key: parsed.key, confirm: sentenceOf(parsed) }, parsed.on) : null;
        if (refused !== null) return refused;
        await client.pressKey(ctx.agentId, parsed.key, ctx.signal, parsed.on);
        return actionResult(`Pressed ${parsed.key}`, { key: parsed.key });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

export function createComputerScrollTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.scroll',
    description: '',
    parameters: {
      type: 'object',
      properties: { deltaY: { type: 'number' }, deltaX: { type: 'number' }, ...ON_PROPERTY },
      required: ['deltaY'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = scrollSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const input = { deltaY: parsed.deltaY, ...(parsed.deltaX === undefined ? {} : { deltaX: parsed.deltaX }) };
        await client.scroll(ctx.agentId, input, ctx.signal, parsed.on);
        return actionResult(`Scrolled ${parsed.deltaY}`, input);
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
