/**
 * computer.snapshot / computer.act / computer.verify: working an app on the owner's Mac through cua-driver (BACKEND §7.12).
 * Always the Mac (the sandbox keeps its screenshot / click tools). The first use of an app asks the owner (tool policy
 * builtin.mac-app), reading its window included; bringing an app to the front asks every time (builtin.mac-foreground).
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { ComputerError } from '../computer/contract.js';
import { requireComputerClient, type ComputerClientProvider } from '../computer/client.js';
import { APPROVAL_PROPERTY, computerFailure } from '../computer/shared.js';
import type { MacDesktopAction, MacDesktopResult } from '../../../ports/computer/index.js';
import { noteMacAppUsed } from '../../mac-apps.js';

/** The three tools; an agent without Mac access is not offered them, and policy asks per app for them. */
export const MAC_DESKTOP_TOOL_NAMES: ReadonlySet<string> = new Set(['computer.snapshot', 'computer.act', 'computer.verify']);

const APP = { type: 'string', description: '' } as const;
const app = z.string().trim().min(1).max(160);

const snapshotSchema = z.object({ app, query: z.string().max(200).optional(), screenshot: z.boolean().optional() });
const actSchema = z.object({
  app,
  steps: z.array(z.object({
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
    wait_for: z.record(z.string(), z.unknown()).optional(),
    expect: z.array(z.record(z.string(), z.unknown())).max(4).optional(),
    timeout_ms: z.number().int().min(0).max(10_000).optional(),
  })).min(1).max(32),
  foreground: z.boolean().optional(),
  confirm: z.string().optional(),
  approval: z.unknown().optional(),
});
const verifySchema = z.object({ app, expect: z.array(z.record(z.string(), z.unknown())).min(1).max(8) });

/** One call to the Mac; the text, the picture when there is one, and the foreground hint in words the model can act on. */
function shaped(name: string, result: MacDesktopResult): ToolResult {
  const hint = result.needsForeground === true
    ? `\nNot done: ${name} only takes this input when it is in front. If the user's current work allows it, call computer.act again with foreground true (the user is asked first); otherwise tell them.`
    : '';
  return {
    content: [
      { type: 'text', text: result.text + hint },
      ...(result.image === undefined ? [] : [{ type: 'image' as const, mimeType: result.image.mimeType, data: result.image.data }]),
    ],
    ...(result.ok ? {} : { isError: true }),
    details: { app: name, ok: result.ok, ...(result.needsForeground === true ? { needsForeground: true } : {}) },
  };
}

async function run(opts: { computer?: ComputerClientProvider }, ctx: ToolContext, action: MacDesktopAction, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    const client = requireComputerClient(opts.computer);
    if (client.macDesktop === undefined) throw new ComputerError('unavailable', "Working apps on the Mac is not available on this agent's Mac connection.");
    const result = await client.macDesktop(ctx.agentId, action, input, ctx.signal);
    // Lets the owner see which allowed apps are alive; never fails the call.
    await noteMacAppUsed(ctx.store, String(input['app'])).catch(() => undefined);
    return shaped(String(input['app']), result);
  } catch (error) {
    return computerFailure(error, ctx.signal);
  }
}

export function createComputerSnapshotTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.snapshot',
    description: '',
    parameters: {
      type: 'object',
      properties: { app: APP, query: { type: 'string', description: '' }, screenshot: { type: 'boolean', description: '' } },
      required: ['app'],
      additionalProperties: false,
    },
    // A read: redo it after an interruption.
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      return run(opts, ctx, 'snapshot', snapshotSchema.parse(args));
    },
  };
}

export function createComputerActTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.act',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        app: APP,
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', enum: ['click', 'double_click', 'right_click', 'set_value', 'type_text', 'press_key', 'hotkey', 'scroll', 'drag'] },
              args: { type: 'object', description: '' },
              expect: { type: 'array', items: { type: 'object' }, description: '' },
            },
            required: ['tool'],
          },
        },
        foreground: { type: 'boolean', description: '' },
        ...APPROVAL_PROPERTY,
      },
      required: ['app', 'steps'],
      additionalProperties: false,
    },
    // A click or a typed text is a committed side effect: never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { confirm: _confirm, approval: _approval, ...input } = actSchema.parse(args);
      return run(opts, ctx, 'act', input);
    },
  };
}

export function createComputerVerifyTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.verify',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        app: APP,
        expect: { type: 'array', items: { type: 'object' }, description: '' },
      },
      required: ['app', 'expect'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      return run(opts, ctx, 'verify', verifySchema.parse(args));
    },
  };
}
