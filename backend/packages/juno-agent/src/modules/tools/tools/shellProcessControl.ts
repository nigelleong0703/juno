/**
 * shell.input / shell.stop — control a process started with shell.start.
 *
 * Input is delivered to the process's stdin inside the sandbox; a process that never reads its stdin
 * leaves the write bounded and the sandbox reports a truthful refusal. Stop signals the recorded
 * process (its whole process group when the runtime provides setsid) and records the stopped state.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient } from '../computer/client.js';
import { actionResult, computerFailure, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { processComputer, requireProcessMethod, type ProcessToolOptions } from './shellProcess.js';
import { endBackgroundTask, exitOutcome } from '../../tasks/background-registry.js';

/** A single input write is bounded to 64 KiB, matching the computerd route. */
const MAX_INPUT_BYTES = 65_536;
const inputSchema = z.object({ handle: z.string().min(1), data: z.string().max(MAX_INPUT_BYTES), on: ON_SCHEMA });

export function createShellInputTool(opts: ProcessToolOptions): Tool {
  return {
    name: 'shell.input',
    description: '',
    parameters: {
      type: 'object',
      properties: { handle: { type: 'string' }, data: { type: 'string' }, ...ON_PROPERTY },
      required: ['handle', 'data'],
      additionalProperties: false,
    },
    // Delivering input is a committed side effect; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = inputSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const write = requireProcessMethod(client.writeProcess?.bind(client), 'input');
        const written = await write(ctx.agentId, { handle: parsed.handle, data: parsed.data }, ctx.signal, await processComputer(ctx, parsed.handle, parsed.on));
        return actionResult('Sent ' + written.bytes + ' byte(s) to ' + written.handle, { handle: written.handle, bytes: written.bytes });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

const stopSchema = z.object({ handle: z.string().min(1), on: ON_SCHEMA });

export function createShellStopTool(opts: ProcessToolOptions): Tool {
  return {
    name: 'shell.stop',
    description: '',
    parameters: {
      type: 'object',
      properties: { handle: { type: 'string' }, ...ON_PROPERTY },
      required: ['handle'],
      additionalProperties: false,
    },
    // Stopping is a committed side effect; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = stopSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const stop = requireProcessMethod(client.stopProcess?.bind(client), 'stop');
        const stopped = await stop(ctx.agentId, { handle: parsed.handle }, ctx.signal, await processComputer(ctx, parsed.handle, parsed.on));
        // The registry row ends too (a watcher that later sees the stop stays silent); a finished process keeps its end.
        await endBackgroundTask(ctx.store, 'shell-' + ctx.agentId + '-' + parsed.handle, stopped.state === 'exited' ? 'completed' : 'stopped', new Date().toISOString(), exitOutcome(stopped.exitCode));
        return actionResult(
          'Process ' + stopped.handle + ' is ' + stopped.state + (stopped.exitCode === null ? '' : ' (exit ' + stopped.exitCode + ')'),
          { handle: stopped.handle, state: stopped.state, exitCode: stopped.exitCode },
        );
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
