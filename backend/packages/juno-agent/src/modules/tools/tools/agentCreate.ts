/**
 * agent_create: new agents inherit the requester's computer.
 *
 * Ownership is recorded from the authenticated requester (createdBy plus the
 * ownerId document field the store carries). Nothing hardcodes a
 * computer id: without the current agent record there is no computer to
 * inherit, so creation fails closed.
 */
import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { newId, nowIso } from '../util.js';
import { onboardNewAgent } from '../../onboarding.js';
import { agentNameTaken, agentNameTakenMessage, freshAgentName, readBoolean, requireRequesterContext } from './relationPolicy.js';

const agentCreateSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
});

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createAgentCreateTool(opts: { store: Store }): Tool {
  return {
    name: 'agent_create',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '' },
        description: { type: 'string' },
      },
    },
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = agentCreateSchema.parse(args);
      const given = parsed.name?.trim() ?? '';
      const auth = await requireRequesterContext(ctx);
      if (!auth.ok) return errorResult(auth.error);
      // No name: the owner's first unused name from the short list. A name that is given and taken is refused.
      if (given.length > 0 && (await agentNameTaken(opts.store, auth.value.ownerId, given))) return errorResult('Error: ' + agentNameTakenMessage(given));
      const name = given.length > 0 ? given : await freshAgentName(opts.store, auth.value.ownerId);
      // The new agent has its own sandbox and gets the creator's Mac access, never more.
      const macAccess = readBoolean(auth.value.selfAgent, 'macAccess');
      if (macAccess === undefined) {
        return errorResult('Error: the current agent record has no Mac access setting to inherit; creation denied.');
      }
      const description = parsed.description?.trim() || undefined;
      const agentId = newId('agt');
      const now = nowIso();
      const agent = {
        id: agentId,
        name,
        handle: name.toLowerCase().replace(/\s+/g, '-'),
        avatar: { shape: 'circle' as const, color: 1, eyes: 'happy' as const },
        title: 'Agent',
        description,
        status: 'idle' as const,
        section: 'Agents',
        pinned: false,
        lastActivity: 'Created',
        unreadCount: 0,
        lastActivityAt: now,
        needsYou: 0,
        model: {
          planner: { provider: 'anthropic', model: 'claude-opus' },
          computer: { provider: 'anthropic', model: 'claude-opus' },
          fast: { provider: 'anthropic', model: 'claude-haiku' },
        },
        channels: [{ kind: 'chat' as const, status: 'connected' as const }],
        macAccess,
        skillIds: [],
        pluginIds: [],
        sharing: { publishedToTeam: false },
        createdBy: ctx.ownerId,
        ownerId: auth.value.ownerId,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await ctx.step('create_agent', async () => {
          await opts.store.put('agents', agent, { agentId });
          await opts.store.emit({ type: 'agent.created', agent });
          // The owner will meet this agent: it speaks first in its own direct chat, like one they create themselves.
          await onboardNewAgent({ store: opts.store, enqueuer: ctx.enqueuer }, auth.value.ownerId, agent, { account: false });
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return errorResult('Error: the agent could not be created: ' + msg);
      }
      return {
        content: [{ type: 'text', text: 'Created agent ' + name + ' (' + agentId + ')' }],
      };
    },
  };
}
