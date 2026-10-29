/** shell.run — run a command on this agent's bound computer. */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import {
  defaultEnvironmentSource,
  requireComputerClient,
  requireEnvironment,
  type ComputerClientProvider,
  type ComputerEnvironmentSource,
} from '../computer/client.js';
import { computerFailure, APPROVAL_PROPERTY, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';

/** Same ceiling the harness gives a tool; a long-running command should be awaited, not slept on (BACKEND §4.2). */
const MAX_TIMEOUT_MS = 60_000;

const schema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
  on: ON_SCHEMA,
});

export function createComputerShellTool(opts: {
  computer?: ComputerClientProvider;
  environment?: ComputerEnvironmentSource;
}): Tool {
  return {
    name: 'shell.run',
    description: '',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '' }, timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: '' }, ...ON_PROPERTY, ...APPROVAL_PROPERTY },
      required: ['command'],
      additionalProperties: false,
    },
    // A command may create or modify files; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      const timeoutMs = Math.min(parsed.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
      try {
        const client = requireComputerClient(opts.computer);
        const source = opts.environment ?? defaultEnvironmentSource(opts.computer);
        const env = await requireEnvironment(source, { agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal, ...(parsed.on === undefined ? {} : { on: parsed.on }) });
        const result = await client.runShell(
          ctx.agentId,
          { command: parsed.command, timeoutMs, cwd: env.workingDirectory },
          ctx.signal,
          parsed.on,
        );
        const output = [result.stdout, result.stderr ? `[stderr] ${result.stderr}` : ''].filter(Boolean).join('\n');
        return {
          content: [{ type: 'text', text: output || `Command exited with code ${result.exitCode}` }],
          details: { exitCode: result.exitCode, command: parsed.command, cwd: env.workingDirectory },
          ...(result.exitCode === 0 ? {} : { isError: true }),
        };
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
