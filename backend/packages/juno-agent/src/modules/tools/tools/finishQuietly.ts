// finish_quietly: the quiet exit of a run nobody is waiting on (BACKEND §3.3a). The model calls it instead of writing a reply when there is
// nothing worth telling; the turn driver then ends the run completed with no message anywhere and records the reason on the run.
// Offered only where `offersQuietExit` holds (a routine, a monitor, a system wake, and their children), and refused anywhere else, so it
// can never swallow an answer to the person who started the work.
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { offersQuietExit } from '../../../execution/harness/logic/run-origin.js';

export const QUIET_EXIT_TOOL = 'finish_quietly';
/** What the task list shows: "Nothing to report: <reason>". */
export const QUIET_RESULT_PREFIX = 'Nothing to report: ';

const schema = z.object({ reason: z.string().trim().min(1, 'reason is required: one short line for the person').max(200, 'keep the reason to one short line (200 characters)') });

const result = (text: string, details?: Record<string, unknown>, isError = false): ToolResult =>
  ({ content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(details === undefined ? {} : { details }), ...(isError ? { isError } : {}) });

/** The reason a quiet run carries, as one line. */
export function quietReasonOf(result: Pick<ToolResult, 'details' | 'isError'>): string | undefined {
  const reason = result.isError === true ? undefined : result.details?.['quietReason'];
  return typeof reason === 'string' && reason !== '' ? reason : undefined;
}

/**
 * What discovery (tool_search, tool_load, the first-turn directory) may show of an unattended-only tool in this run: nothing when the run is
 * not quiet-eligible (it must not learn the tool exists), and "already in your list" when it is (the tool is shown to it directly).
 */
export async function scopeQuietExit<T extends Pick<Tool, 'name' | 'unattendedOnly'>>(ctx: ToolContext, all: readonly T[], visible: ReadonlySet<string> = new Set()): Promise<{ all: T[]; visible: ReadonlySet<string> }> {
  const quiet = all.filter((tool) => tool.unattendedOnly === true);
  if (quiet.length === 0) return { all: [...all], visible };
  const offered = offersQuietExit(await ctx.store.get('runs', ctx.runId));
  if (!offered) return { all: all.filter((tool) => tool.unattendedOnly !== true), visible };
  return { all: [...all], visible: new Set([...visible, ...quiet.map((tool) => tool.name)]) };
}

export function createFinishQuietlyTool(): Tool {
  return {
    name: QUIET_EXIT_TOOL,
    description: '',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: '' } },
      required: ['reason'],
      additionalProperties: false,
    },
    replay: 'safe',
    sideEffect: false,
    unattendedOnly: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return result(parsed.error.issues.map((issue) => issue.message).join('; '), undefined, true);
      const offered = await ctx.step('finish-quietly:origin', async () => offersQuietExit(await ctx.store.get('runs', ctx.runId)));
      if (!offered) return result('not available: someone is waiting for your answer here. Reply to them.', undefined, true);
      const reason = parsed.data.reason.replace(/\s+/g, ' ');
      return result('Done. This run ends now and nothing is sent anywhere.', { quietReason: reason });
    },
  };
}
