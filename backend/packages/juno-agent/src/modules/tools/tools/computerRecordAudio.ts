/** computer.record_audio — bounded system-audio recording on the owner's Mac. Audio stays on the Mac. */

import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { requireComputerClient, type ComputerClientProvider } from '../computer/client.js';
import { ComputerError } from '../computer/contract.js';
import { actionResult, computerFailure, ON_PROPERTY } from '../computer/shared.js';

export const DEFAULT_RECORD_SECONDS = 1_800;
export const MAX_RECORD_SECONDS = 3_600;

const schema = z.object({
  on: z.enum(['sandbox', 'mac']).optional(),
  action: z.enum(['start', 'stop']),
  maxDurationSeconds: z.number().int().positive().max(MAX_RECORD_SECONDS).optional(),
  recordingId: z.string().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'stop' && value.recordingId === undefined) ctx.addIssue({ code: 'custom', path: ['recordingId'], message: 'recordingId is required to stop' });
  if (value.action === 'start' && value.recordingId !== undefined) ctx.addIssue({ code: 'custom', path: ['recordingId'], message: 'recordingId is only for stop' });
  if (value.action === 'stop' && value.maxDurationSeconds !== undefined) ctx.addIssue({ code: 'custom', path: ['maxDurationSeconds'], message: 'maxDurationSeconds is only for start' });
});

export function createComputerRecordAudioTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.record_audio',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        ...ON_PROPERTY,
        action: { type: 'string', enum: ['start', 'stop'] },
        maxDurationSeconds: { type: 'number', minimum: 1, maximum: MAX_RECORD_SECONDS, description: '' },
        recordingId: { type: 'string', description: '' },
      },
      required: ['on', 'action'],
      additionalProperties: false,
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      try {
        if (parsed.on !== 'mac') {
          return {
            content: [{ type: 'text', text: 'System-audio recording is unavailable on the sandbox. Use on: "mac" when the task needs audio from the user\'s Mac.' }],
            isError: true,
            details: { code: 'unavailable', computer: parsed.on ?? 'sandbox' },
          };
        }
        const client = requireComputerClient(opts.computer);
        if (client.recordAudio === undefined) {
          throw new ComputerError('unavailable', "System-audio recording is not available on this agent's Mac connection.");
        }
        let input;
        if (parsed.action === 'start') input = { action: 'start' as const, maxDurationSeconds: parsed.maxDurationSeconds ?? DEFAULT_RECORD_SECONDS };
        else {
          if (parsed.recordingId === undefined) throw new ComputerError('failed', 'recordingId is required to stop');
          input = { action: 'stop' as const, recordingId: parsed.recordingId };
        }
        const result = await client.recordAudio(ctx.agentId, input, ctx.signal, 'mac');
        return actionResult(
          parsed.action === 'start'
            ? `Recording system audio as ${result.recordingId} (${result.state}) at ${result.path}.`
            : `Recording ${result.recordingId} is ${result.state} at ${result.path}.`,
          { ...result },
        );
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
