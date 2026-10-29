/**
 * shell.start / shell.poll — asynchronous commands on this agent's bound computer.
 *
 * The process runs detached inside the sandbox and keeps running between calls, so a handle is the
 * only thing carried in context. Output is read back in bounded windows with a byte cursor. Nothing
 * here simulates a process: a client that does not expose async process control reports it unavailable.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import {
  defaultEnvironmentSource,
  requireComputerClient,
  requireEnvironment,
  type ComputerClientProvider,
  type ComputerEnvironmentSource,
} from '../computer/client.js';
import { ComputerError, isEnvAbsolute, resolveEnvPath, type ComputerTarget } from '../computer/contract.js';
import { actionResult, computerFailure, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { BACKGROUND_LIMIT_TEXT, backgroundCapRefusal, backgroundSpawnOf, type BackgroundSpawn } from '../../tasks/child-background.js';
import { recordBackgroundTask, taskLabel } from '../../tasks/background-registry.js';

/** The sandbox's wall-clock ceiling for one process (the computerd route refuses more). */
export const PROCESS_TIMEOUT_MAX_MS = 3_600_000;

export interface ProcessToolOptions {
  computer?: ComputerClientProvider;
  environment?: ComputerEnvironmentSource;
}

/** A method the process tools need, bound to its client; a missing one is a capability error. */
export function requireProcessMethod<M>(method: M | undefined, what: string): M {
  if (typeof method !== 'function') {
    throw new ComputerError('unavailable', 'process control is not available: this deployment exposes no async sandbox processes (' + what + ')');
  }
  return method;
}

const startSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(PROCESS_TIMEOUT_MAX_MS).optional(),
  notifyOnExit: z.boolean().optional(),
  title: z.string().trim().min(1).max(200).optional(),
  on: ON_SCHEMA,
});

export function createShellStartTool(opts: ProcessToolOptions): Tool {
  return {
    name: 'shell.start',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number', description: '' },
        notifyOnExit: { type: 'boolean' },
        title: { type: 'string', description: '' },
        ...ON_PROPERTY,
      },
      required: ['command'],
      additionalProperties: false,
    },
    // Starting a process commits a sandbox side effect; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = startSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const source = opts.environment ?? defaultEnvironmentSource(opts.computer);
        const env = await requireEnvironment(source, { agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal, ...(parsed.on === undefined ? {} : { on: parsed.on }) });
        const cwd = parsed.cwd === undefined ? env.workingDirectory : isEnvAbsolute(parsed.cwd) ? parsed.cwd : resolveEnvPath(env, parsed.cwd);
        const start = requireProcessMethod(client.startProcess?.bind(client), 'start');
        const snapshot = await start(ctx.agentId, { command: parsed.command, cwd, ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }) }, ctx.signal, parsed.on);
        // Every started process is listed (tasks_list); only an armed notify watcher wakes the session and counts toward the chain.
        const spawn = backgroundSpawnOf(ctx.wake, ctx.runId);
        const watch = parsed.notifyOnExit === true ? await watchProcess(ctx, snapshot.handle, spawn, parsed.on) : { note: '', armed: false };
        await recordBackgroundTask(ctx.store, {
          id: 'shell-' + ctx.agentId + '-' + snapshot.handle, ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId, runId: ctx.runId,
          kind: 'shell', ...(parsed.on === 'mac' ? { computer: 'mac' as const } : {}), label: taskLabel(parsed.command), ...(parsed.title === undefined ? {} : { title: taskLabel(parsed.title) }), handle: snapshot.handle, notify: watch.armed, chainId: spawn.chainId, generation: spawn.generation,
          status: 'running', startedAt: new Date().toISOString(),
        });
        const watched = watch.note;
        return actionResult(
          'Started process ' + snapshot.handle + ' (pid ' + (snapshot.pid ?? 'unknown') + ')' + watched,
          { handle: snapshot.handle, pid: snapshot.pid, state: snapshot.state, startedAt: snapshot.startedAt, cwd },
        );
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

const pollSchema = z.object({
  handle: z.string().min(1),
  cursor: z.number().int().min(0).optional(),
  stderrCursor: z.number().int().min(0).optional(),
  maxBytes: z.number().int().positive().optional(),
  on: ON_SCHEMA,
});

/**
 * The computer a process runs on: the one the call names, else the one recorded when it was started (the task list row),
 * else the sandbox. The handle belongs to one computer, so poll, input and stop need not repeat `on`.
 */
export async function processComputer(ctx: ToolContext, handle: string, given: ComputerTarget | undefined): Promise<ComputerTarget | undefined> {
  if (given !== undefined) return given;
  const row = await ctx.store.get('backgroundTasks', 'shell-' + ctx.agentId + '-' + handle);
  return row?.computer;
}

export function createShellPollTool(opts: ProcessToolOptions): Tool {
  return {
    name: 'shell.poll',
    description: '',
    parameters: {
      type: 'object',
      properties: { handle: { type: 'string' }, cursor: { type: 'number' }, stderrCursor: { type: 'number' }, maxBytes: { type: 'number' }, ...ON_PROPERTY },
      required: ['handle'],
      additionalProperties: false,
    },
    // Reading output is safe to redo after an interruption.
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = pollSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const read = requireProcessMethod(client.readProcess?.bind(client), 'poll');
        const on = await processComputer(ctx, parsed.handle, parsed.on);
        const output = await read(
          ctx.agentId,
          {
            handle: parsed.handle,
            ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
            ...(parsed.stderrCursor === undefined ? {} : { stderrCursor: parsed.stderrCursor }),
            ...(parsed.maxBytes === undefined ? {} : { maxBytes: parsed.maxBytes }),
          },
          ctx.signal,
          on,
        );
        const content: ToolResult['content'] = [{ type: 'text', text: output.output || '(no new output)' }];
        if (output.stderr !== '') content.push({ type: 'text', text: '[stderr] ' + output.stderr });
        if (output.truncated) content.push({ type: 'text', text: '[bounded: more output remains; poll again with cursor=' + output.cursor + ']' });
        if (output.stderrTruncated) content.push({ type: 'text', text: '[bounded: more stderr remains; poll again with stderrCursor=' + output.stderrCursor + ']' });
        return {
          content,
          details: {
            handle: output.handle,
            state: output.state,
            exitCode: output.exitCode,
            cursor: output.cursor,
            stderrCursor: output.stderrCursor,
            totalBytes: output.totalBytes,
            stderrTotalBytes: output.stderrTotalBytes,
            truncated: output.truncated,
            stderrTruncated: output.stderrTruncated,
          },
        };
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

/**
 * H-72: register the durable watcher. The process already runs, so a watcher that cannot be started
 * is reported (the model can still poll) instead of failing the start.
 */
async function watchProcess(ctx: ToolContext, handle: string, spawn: BackgroundSpawn, on: ComputerTarget | undefined): Promise<{ note: string; armed: boolean }> {
  const watch = ctx.enqueuer.watchTask?.bind(ctx.enqueuer);
  if (watch === undefined) return { note: '. Exit notification is unavailable here: poll it with shell.poll.', armed: false };
  // The chain's total and generation caps, shared with child, MCP and wait_for background starts.
  if ((await backgroundCapRefusal(ctx.store, ctx.conversationId, spawn)) !== undefined) return { note: '. No exit notification: ' + BACKGROUND_LIMIT_TEXT + ' (poll it with shell.poll).', armed: false };
  try {
    await watch({
      taskId: 'shell-' + ctx.agentId + '-' + handle, ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId,
      handle, startedAt: Date.now(), generation: spawn.generation, originRunId: ctx.runId, ...(on === 'mac' ? { computer: 'mac' as const } : {}), ...(ctx.wake.hop === undefined ? {} : { hop: ctx.wake.hop }),
    });
    return { note: '. You will be woken with a task_done when it exits.', armed: true };
  } catch {
    return { note: '. Exit notification could not be armed: poll it with shell.poll.', armed: false };
  }
}
