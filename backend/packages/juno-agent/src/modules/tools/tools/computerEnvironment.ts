/** computer_environment — read-only view of this agent's bound computer. */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import type { ComputerEnvironment } from '../../../ports/computer/index.js';
import {
  defaultEnvironmentSource,
  requireEnvironment,
  type ComputerClientProvider,
  type ComputerEnvironmentSource,
} from '../computer/client.js';
import { computerFailure, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';

const schema = z.object({ on: ON_SCHEMA });

export function createComputerEnvironmentTool(opts: {
  computer?: ComputerClientProvider;
  environment?: ComputerEnvironmentSource;
}): Tool {
  return {
    name: 'computer_environment',
    description: '',
    parameters: { type: 'object', properties: { ...ON_PROPERTY }, additionalProperties: false },
    // A read of remote metadata; safe to redo after an interruption.
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      try {
        const source = opts.environment ?? defaultEnvironmentSource(opts.computer);
        const env = await requireEnvironment(source, {
          agentId: ctx.agentId,
          runId: ctx.runId,
          signal: ctx.signal,
          ...(parsed.on === undefined ? {} : { on: parsed.on }),
        });
        return {
          content: [{ type: 'text', text: renderEnvironment(env) }],
          details: { ...env },
        };
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

function renderEnvironment(env: ComputerEnvironment): string {
  return [
    env.kind === 'mac' ? "The user's own Mac (posix paths; your folder is the working directory):" : 'The sandbox (posix paths):',
    'working directory: ' + env.workingDirectory,
    'user: ' + env.user + ' (home: ' + env.home + ')',
    'os: ' + env.os + ' (platform: ' + env.platform + ')',
    ...(env.device === undefined ? [] : ['declared actions: ' + (env.device.actions.join(', ') || 'none') + ' (anything else is not granted on the Mac and is refused)']),
  ].join('\n');
}
