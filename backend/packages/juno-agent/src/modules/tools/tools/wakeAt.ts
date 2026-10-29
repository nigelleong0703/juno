import { z } from 'zod';
import type { Enqueuer, Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { durationMs } from '../duration.js';

/** Mirrors the harness threshold (pi-core time-wait): longer waits end the turn and return as a timer wake. */
export const WAKE_DEFER_THRESHOLD_MS = 2 * 60_000;

const wakeAtSchema = z.object({
  when: z.string(),
  reason: z.string().optional(),
});

export function createWakeAtTool(_opts: { store: Store; enqueuer: Enqueuer }): Tool {
  return {
    name: 'wake_at',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', description: '' },
        reason: { type: 'string' },
      },
      required: ['when'],
    },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const parsed = wakeAtSchema.parse(args);
      const until = resolveUntil(parsed.when);
      // H-74: a long wait is handed to a timer wake (journaled flag, so runs started before this
      // change keep their in-run sleep on replay). The model stays in the turn to acknowledge.
      const defer = Date.parse(until) - Date.now() > WAKE_DEFER_THRESHOLD_MS;
      const text = defer
        ? `Scheduled a wake-up at ${until}. You are free until then: tell the user it is set, then finish this turn; you will be woken in this chat at that time.`
        : `Waited until ${until}: that time has come. Carry on with what you were waiting for.`;
      return {
        content: [{ type: 'text', text }],
        suspend: { reason: 'time', until },
        // `steerable` (journaled): a short sleep that new input ends early (time-wait.ts waitUntilSteerable).
        details: { ...(defer ? { defer: true } : { steerable: true }), ...(parsed.reason === undefined ? {} : { reason: parsed.reason }) },
      };
    },
  };
}

function resolveUntil(when: string): string {
  if (when.trim().startsWith('+')) return new Date(Date.now() + durationMs(when)).toISOString();
  return new Date(when).toISOString();
}
