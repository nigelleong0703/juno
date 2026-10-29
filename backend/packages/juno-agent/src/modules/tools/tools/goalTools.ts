// goal_update / suggest: the agent's side of the owner's `goals` and `ideas` collections. Owner and agent
// always come from the ToolContext, never from arguments. A goal is the agent's own: it can only change goals it wrote.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import type { Idea } from '@agent-desktop/public-contracts';
import { docOwner } from '../../../execution/execution-owner.js';
import { goalWriteSchema, writeGoal } from '../../goals/write.js';
import { listAll } from '../../memory/util.js';
import { blockedReason } from '../../ideas/cooldown.js';
import { nowIso } from '../util.js';

const suggestSchema = z.object({ text: z.string().trim().min(1), prompt: z.string().trim().min(1) });

function result(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: isError ? 'Error: ' + text : text }], ...(isError ? { isError } : {}) };
}

/** The caller's owner and agent; refuses to touch goals or ideas without both. */
function caller(ctx: ToolContext): { ownerId: string; agentId: string } | undefined {
  return ctx.ownerId.length > 0 && ctx.agentId.length > 0 ? { ownerId: ctx.ownerId, agentId: ctx.agentId } : undefined;
}

const noCaller = (): ToolResult => result('no owner or agent context, so goals and ideas are unavailable.', true);

export function createGoalUpdateTool(): Tool {
  return {
    name: 'goal_update',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '' },
        kind: { enum: ['tracking', 'goal'], description: '' },
        title: { type: 'string', description: '' },
        summary: { type: 'string', description: 'One line to the person you are helping: where it stands now ("You have booked flights; the hotel is next").' },
        steps: {
          type: 'array',
          description: '',
          items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text', 'done'] },
        },
        status: { enum: ['active', 'paused', 'done'], description: '' },
        milestones: {
          type: 'array',
          description: '',
          items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, status: { enum: ['todo', 'doing', 'done', 'blocked'] }, due: { type: 'string', description: '' } }, required: ['title', 'status'] },
        },
        nextCheckAt: { type: 'string', description: '' },
        note: { type: 'string', description: '' },
      },
      required: ['title', 'summary'],
    },
    replay: 'safe',
    sideEffect: true,
    // The owner's goals: offered only in a run where the owner is alone with the agent (as the goal section of the context is).
    ownerOnly: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = goalWriteSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('goal_update', args, parsed.error);
      const who = caller(ctx);
      if (who === undefined) return noCaller();
      const input = parsed.data;
      // One durable step: a replay returns the recorded outcome instead of creating a second goal.
      return ctx.step('goal_update', async (): Promise<ToolResult> => {
        const written = await writeGoal(ctx, { ...who, runId: ctx.runId }, input);
        if (!written.ok) return result(written.error, true);
        return result((written.created ? 'Created goal ' : 'Updated goal ') + written.goal.id + '.');
      });
    },
  };
}

export function createSuggestTool(): Tool {
  return {
    name: 'suggest',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '' },
        prompt: { type: 'string', description: '' },
      },
      required: ['text', 'prompt'],
    },
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = suggestSchema.safeParse(args);
      if (!parsed.success) return result('"text" and "prompt" must be non-empty strings.', true);
      const who = caller(ctx);
      if (who === undefined) return noCaller();
      const { text, prompt } = parsed.data;
      return ctx.step('suggest', async (): Promise<ToolResult> => {
        const rows = (await listAll(ctx.store, 'ideas')).filter((row) => docOwner(row) === who.ownerId);
        const duplicate = rows.some((row) => row.agentId === who.agentId && row.status === 'open' && (row.text === text || row.prompt === prompt));
        if (duplicate) return result('an open suggestion with the same text or prompt already exists; do not repeat it.', true);
        const blocked = blockedReason({ text }, rows, new Date());
        if (blocked !== undefined) return result('this suggestion is not offered again for now (' + blocked + ').', true);
        const now = nowIso();
        const idea: Idea & { ownerId: string } = {
          id: 'idea-' + String(Date.now()) + '-' + randomUUID().slice(0, 8),
          ownerId: who.ownerId,
          agentId: who.agentId,
          text,
          prompt,
          status: 'open',
          source: 'agent',
          createdAt: now,
          updatedAt: now,
        };
        const created = await ctx.store.put('ideas', idea);
        await ctx.store.emit({ type: 'idea.updated', idea: created });
        return result('Suggested to the user: ' + text);
      });
    },
  };
}
