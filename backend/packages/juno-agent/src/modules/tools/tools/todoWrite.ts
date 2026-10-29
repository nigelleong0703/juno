import { z } from 'zod';
import type { Store, Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { newId } from '../util.js';
import { writeBoundTaskPlan } from '../../tasks/plan-write.js';
import type { TodoDraft } from '../../tasks/state.js';

const todoStatusSchema = z.enum(['pending', 'in_progress', 'done', 'blocked']);

const todoWriteSchema = z.object({
  todos: z.array(z.object({
    id: z.string().optional(),
    content: z.string(),
    status: todoStatusSchema.optional(),
    note: z.string().optional(),
    evidence: z.string().optional(),
  })),
  merge: z.boolean().optional(),
});

const todoWriteParameters = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: '',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '' },
          content: { type: 'string', description: '' },
          status: { enum: ['pending', 'in_progress', 'done', 'blocked'], description: '' },
          note: { type: 'string', description: '' },
          evidence: { type: 'string', description: '' },
        },
        required: ['content'],
      },
    },
    merge: { type: 'boolean', description: '' },
  },
  required: ['todos'],
};

function error(text: string): ToolResult {
  return { content: [{ type: 'text', text: 'Error: ' + text }], isError: true };
}

async function contextAuthorityError(store: Store, ctx: ToolContext): Promise<string | null> {
  if (!ctx.agentId) return 'agent context required';
  if (!ctx.conversationId) return 'conversation context required';
  const conversation = await store.get('conversations', ctx.conversationId);
  if (conversation && !conversation.agentIds.includes(ctx.agentId)) {
    return 'agent is not a member of conversation ' + ctx.conversationId;
  }
  return null;
}

type TodoEntry = z.infer<typeof todoWriteSchema>['todos'][number];

function toDraft(entry: TodoEntry): TodoDraft | string {
  const text = entry.content.trim();
  if (text.length === 0) return 'each todo requires non-empty content';
  const note = entry.note?.trim();
  if (entry.status === 'blocked' && !note) return 'a blocked todo requires a non-empty note naming the missing input or dependency';
  const claim = entry.evidence?.trim();
  return {
    id: entry.id || newId('itm'),
    text,
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(note ? { note } : {}),
    ...(claim ? { evidence: { at: new Date().toISOString(), passed: false, summary: 'unverified claim: ' + claim.slice(0, 500) } } : {}),
  };
}

export function createTodoWriteTool(opts: { store: Store }): Tool {
  return {
    name: 'todo_write',
    description: '',
    parameters: todoWriteParameters,
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = todoWriteSchema.parse(args);
      const merge = parsed.merge !== false;
      if (parsed.todos.length === 0 && merge) return error('items array required');
      const authorityError = await contextAuthorityError(opts.store, ctx);
      if (authorityError) return error(authorityError);
      const todos: TodoDraft[] = [];
      for (const entry of parsed.todos) {
        const draft = toDraft(entry);
        if (typeof draft === 'string') return error(draft);
        todos.push(draft);
      }
      let plan;
      try {
        plan = await ctx.step('write_plan', () =>
          writeBoundTaskPlan(opts.store, ctx.agentId, ctx.conversationId, ctx.runId, todos, merge),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return error('child plan binding invalid: ' + message);
      }
      const blocked = plan.todos.filter((todo) => todo.status === 'blocked').length;
      const suffix = blocked > 0 ? ', ' + String(blocked) + ' blocked' : '';
      return {
        content: [{ type: 'text', text: 'Updated plan: ' + String(plan.todos.length) + ' entries' + suffix }],
        details: { planId: plan.id, todoIds: plan.todos.map((todo) => todo.id) },
      };
    },
  };
}
