/**
 * computer_copy — copy a file or folder between the agent's two computers (its sandbox and the owner's Mac).
 *
 * The bytes move inside computerd, never through the model. Paths are resolved against the computer they are on (relative paths
 * start in its working directory); without `toPath` the copy lands in the destination's working directory under the same name.
 * The tool policy asks before anything on the Mac outside ~/Juno is read or written, like every other Mac call.
 */
import { posix } from 'node:path';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import {
  defaultEnvironmentSource,
  requireComputerClient,
  requireEnvironment,
  type ComputerClientProvider,
  type ComputerEnvironmentSource,
} from '../computer/client.js';
import { ComputerError, resolveEnvPath, type ComputerTarget } from '../computer/contract.js';
import { actionResult, computerFailure, ON_VALUES } from '../computer/shared.js';

const schema = z.object({
  from: z.enum(ON_VALUES),
  to: z.enum(ON_VALUES),
  path: z.string().min(1),
  toPath: z.string().min(1).optional(),
});

const NAME: Record<ComputerTarget, string> = { sandbox: 'the sandbox', mac: 'your Mac' };

/** "report.pdf from the sandbox to your Mac": the words the step row and the result use. */
export function copyPhrase(from: ComputerTarget, to: ComputerTarget, path: string): string {
  return `${posix.basename(path.replace(/\/+$/, '')) || path} from ${NAME[from]} to ${NAME[to]}`;
}

export function createComputerCopyTool(opts: { computer?: ComputerClientProvider; environment?: ComputerEnvironmentSource }): Tool {
  return {
    name: 'computer_copy',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', enum: [...ON_VALUES], description: '' },
        to: { type: 'string', enum: [...ON_VALUES], description: '' },
        path: { type: 'string', description: '' },
        toPath: { type: 'string', description: '' },
      },
      required: ['from', 'to', 'path'],
      additionalProperties: false,
    },
    // A copy writes files; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      if (parsed.from === parsed.to) return { content: [{ type: 'text', text: 'Error: from and to are the same computer; use shell.run (cp) for that.' }], isError: true };
      try {
        const client = requireComputerClient(opts.computer);
        if (typeof client.copy !== 'function') throw new ComputerError('unavailable', 'copying between computers is not available on this deployment');
        const source = opts.environment ?? defaultEnvironmentSource(opts.computer);
        const request = { agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal };
        const [fromEnv, toEnv] = [await requireEnvironment(source, { ...request, on: parsed.from }), await requireEnvironment(source, { ...request, on: parsed.to })];
        const path = resolveEnvPath(fromEnv, parsed.path);
        const toPath = resolveEnvPath(toEnv, parsed.toPath ?? posix.basename(path.replace(/\/+$/, '')));
        const done = await client.copy(ctx.agentId, { from: parsed.from, to: parsed.to, path, toPath }, ctx.signal);
        const phrase = copyPhrase(parsed.from, parsed.to, path);
        return actionResult(`Copied ${phrase} (${done.kind}, ${done.bytes} bytes) -> ${done.toPath}`, { from: parsed.from, to: parsed.to, path, toPath: done.toPath, bytes: done.bytes, kind: done.kind });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
