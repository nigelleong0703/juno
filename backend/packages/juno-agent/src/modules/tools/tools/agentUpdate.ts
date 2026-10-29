import { z } from 'zod';
import { invalidArguments } from '../toolArguments.js';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { nowIso } from '../util.js';
import { withLiveStatus } from '../../../execution/agent-status.js';
import { agentNameTaken, agentNameTakenMessage, isOwnedAgent } from './relationPolicy.js';
import type { ComputerClientProvider } from '../computer/client.js';
import { writeHomeFile } from '../../home/service.js';
import { agentFilePath } from '../../home/paths.js';

const PERSONA_MAX_CHARS = 4000;

const agentUpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  // null clears the persona (the default applies); leaving it out keeps it.
  persona: z.string().trim().max(PERSONA_MAX_CHARS).nullable().optional(),
});

export function createAgentUpdateTool(opts: { store: Store; computer?: ComputerClientProvider }): Tool {
  return {
    name: 'agent_update',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string', description: '' },
        persona: { type: ['string', 'null'], maxLength: PERSONA_MAX_CHARS, description: '' },
      },
      required: ['id'],
    },
    clearable: ['persona'],
    replay: 'safe',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = agentUpdateSchema.safeParse(args);
      if (!parsed.success) return invalidArguments('agent_update', args, parsed.error);
      const input = parsed.data;
      const id = input.id;
      const nameInput = input.name;
      const descriptionInput = input.description;

      const existing = await opts.store.get('agents', id);
      // Not the caller's own agent reads as not found, even when the store is not owner-scoped.
      if (!existing || !isOwnedAgent(existing, ctx.ownerId)) {
        return {
          content: [{ type: 'text', text: `Error: agent ${id} not found` }],
          isError: true,
        };
      }

      // Who the agent is comes only from its owner: never on a stranger's or another agent's word.
      if ((nameInput !== undefined || descriptionInput !== undefined || input.persona !== undefined) && !ctx.wake.trusted) {
        return { content: [{ type: 'text', text: "Error: only the owner can change an agent's name, subtitle or persona" }], isError: true };
      }

      if (nameInput !== undefined && nameInput.trim() !== '' && (await agentNameTaken(opts.store, ctx.ownerId, nameInput, id))) {
        return { content: [{ type: 'text', text: 'Error: ' + agentNameTakenMessage(nameInput) }], isError: true };
      }

      const updated = { ...existing };
      if (nameInput) {
        updated.name = String(nameInput);
      }
      if (descriptionInput) {
        updated.description = String(descriptionInput);
      }
      updated.updatedAt = nowIso();

      await ctx.step('update_agent', async () => {
        await opts.store.put('agents', updated, { agentId: id });
        await opts.store.emit({ type: 'agent.updated', agent: await withLiveStatus(opts.store, updated) });
      });
      if (input.persona !== undefined) {
        const persona = input.persona ?? '';
        // Computer first, mirror always (pending when the computer is away), the same path as the owner's own edit.
        const client = opts.computer?.();
        await ctx.step('update_persona', async () => {
          await writeHomeFile({ store: opts.store, ...(client?.home === undefined ? {} : { home: client.home }) }, {
            ownerId: ctx.ownerId, agentId: id, path: agentFilePath(id, 'IDENTITY.md'), content: persona === '' ? '' : persona + '\n', writer: 'agent', signal: ctx.signal,
          });
        });
      }

      // Say exactly what changed and what this tool cannot change, so the reply never claims more than was written.
      const changed = [
        ...(nameInput ? [`name is now "${updated.name}"`] : []),
        ...(descriptionInput ? [`description (the one-line profile subtitle) is now "${updated.description}"`] : []),
        ...(input.persona === undefined ? [] : [input.persona === null || input.persona === '' ? 'persona (IDENTITY.md) is cleared; the default persona applies from the next message' : 'persona (IDENTITY.md) is replaced; it applies from the next message']),
      ];
      return {
        content: [{
          type: 'text',
          text: (changed.length === 0 ? `Nothing changed on agent ${id}.` : `Updated agent ${id}: ${changed.join('; ')}.`)
            + ' Principles and instructions were not changed: this tool cannot edit them (SOUL.md and AGENTS.md, edited by the owner under Identity).',
        }],
      };
    },
  };
}
