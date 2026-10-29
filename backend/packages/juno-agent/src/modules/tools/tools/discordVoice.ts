import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';

/** What the Discord voice tools need from the host that holds the gateway connection (agentd). */
export interface VoicePort {
  /** `signal` is the run's stop: a port that waits on another process stops waiting (the connection itself is not undone). */
  join(input: { ownerId: string; agentId: string; conversationId: string; channelId?: string }, signal?: AbortSignal): Promise<VoiceReply>;
  leave(input: { ownerId: string; agentId: string }, signal?: AbortSignal): Promise<VoiceReply>;
  transcript(input: { ownerId: string; agentId: string; sinceMinutes?: number }, signal?: AbortSignal): Promise<VoiceReply>;
}

export type VoiceReply = { ok: true; text: string } | { ok: false; error: string };

function toResult(reply: VoiceReply): ToolResult {
  return reply.ok
    ? { content: [{ type: 'text', text: reply.text }] }
    : { content: [{ type: 'text', text: `Error: ${reply.error}` }], isError: true };
}

export function createVoiceJoinTool(port: VoicePort): Tool {
  const schema = z.object({ channelId: z.string().min(1).optional() });
  return {
    name: 'discord_voice_join',
    description: '',
    parameters: { type: 'object', properties: { channelId: { type: 'string', description: '' } } },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args ?? {});
      if (!ctx.wake.trusted) return toResult({ ok: false, error: 'only the owner can ask you to join a voice channel' });
      return toResult(await port.join({
        ownerId: ctx.ownerId, agentId: ctx.agentId, conversationId: ctx.conversationId,
        ...(parsed.channelId === undefined ? {} : { channelId: parsed.channelId }),
      }, ctx.signal));
    },
  };
}

export function createVoiceLeaveTool(port: VoicePort): Tool {
  return {
    name: 'discord_voice_leave',
    description: '',
    parameters: { type: 'object', properties: {} },
    replay: 'never',
    sideEffect: true,
    async execute(_args: unknown, ctx: ToolContext): Promise<ToolResult> {
      return toResult(await port.leave({ ownerId: ctx.ownerId, agentId: ctx.agentId }, ctx.signal));
    },
  };
}

export function createVoiceTranscriptTool(port: VoicePort): Tool {
  const schema = z.object({ sinceMinutes: z.number().positive().optional() });
  return {
    name: 'discord_voice_transcript',
    description: '',
    parameters: { type: 'object', properties: { sinceMinutes: { type: 'number' } } },
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args ?? {});
      return toResult(await port.transcript({
        ownerId: ctx.ownerId, agentId: ctx.agentId,
        ...(parsed.sinceMinutes === undefined ? {} : { sinceMinutes: parsed.sinceMinutes }),
      }, ctx.signal));
    },
  };
}
