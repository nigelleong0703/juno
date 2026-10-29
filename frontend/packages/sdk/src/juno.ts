import type { AgentEvent, AgentTask, EventSource } from '@agent-desktop/client';
import { createHttpClient } from '@agent-desktop/client/http';
import { Chat } from './chat.js';
import { JunoError, guard } from './errors.js';
import { EventHub } from './hub.js';
import type { ChatTarget, Juno, JunoOptions } from './types.js';
import type { TurnContext } from './turn.js';

/** The one task status after which a task never changes again (`outcome` then says how it ended). */
const FINISHED_TASK_STATUSES: ReadonlySet<AgentTask['status']> = new Set(['ended']);
/** How many finished task ids are remembered, so a repeated update does not fire the event twice. */
const REMEMBERED_TASK_IDS = 1000;

/** Creates a Juno client. Nothing is requested until a chat is opened or a listener is added. */
export function createJuno(options: JunoOptions): Juno {
  if (!options.token) throw new JunoError('INVALID_ARGUMENT', 'createJuno needs a non-empty token');
  try {
    new URL(options.baseUrl);
  } catch (error) {
    throw new JunoError('INVALID_ARGUMENT', `createJuno needs an absolute baseUrl, got "${options.baseUrl}"`, { cause: error });
  }

  const http = createHttpClient({
    baseUrl: options.baseUrl,
    getToken: () => options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const events: EventSource = http;
  const hub = new EventHub(events);

  let closed = false;
  const turnFailures = new Set<(error: unknown) => void>();
  const turnContext: TurnContext = {
    api: http,
    hub,
    register: (fail) => {
      turnFailures.add(fail);
      return () => {
        turnFailures.delete(fail);
      };
    },
    isClosed: () => closed,
  };

  const taskListeners = new Set<{ handler: (task: AgentTask) => void }>();
  const finishedTasks = new Set<string>();
  let detachTasks: (() => void) | null = null;
  const onTaskEvent = (event: AgentEvent): void => {
    if (event.type !== 'task.updated') return;
    const task = event.task;
    if (!FINISHED_TASK_STATUSES.has(task.status) || finishedTasks.has(task.id)) return;
    finishedTasks.add(task.id);
    if (finishedTasks.size > REMEMBERED_TASK_IDS) {
      const [oldest] = finishedTasks;
      if (oldest !== undefined) finishedTasks.delete(oldest);
    }
    for (const listener of [...taskListeners]) {
      try {
        listener.handler(task);
      } catch (error) {
        // One throwing listener must not starve the others; rethrow it outside the event loop so it is not lost.
        setTimeout(() => {
          throw error;
        }, 0);
      }
    }
  };

  const assertOpen = (): void => {
    if (closed) throw new JunoError('CLOSED', 'The Juno client is closed');
  };

  return {
    async chat(target: ChatTarget): Promise<Chat> {
      assertOpen();
      if ('conversationId' in target) {
        const conversation = await guard(http.conversations.get(target.conversationId));
        return new Chat(turnContext, conversation);
      }
      const agentId = target.agentId;
      // The app's own open-direct-chat path: reuse the agent's direct chat, else create it.
      const listed = await guard(http.conversations.list({ agentId, kind: 'direct' }));
      const existing = listed.items.find(
        (conversation) => conversation.kind === 'direct' && conversation.agentIds.length === 1 && conversation.agentIds[0] === agentId,
      );
      if (existing) return new Chat(turnContext, existing);
      // A fixed requestId makes concurrent opens for the same agent resolve to one conversation.
      const created = await guard(
        http.conversations.create({ kind: 'direct', memberAgentIds: [agentId], requestId: `juno-sdk:direct:${agentId}` }),
      );
      return new Chat(turnContext, created);
    },

    on(event: 'task.finished', handler: (task: AgentTask) => void): () => void {
      assertOpen();
      if (event !== 'task.finished') throw new JunoError('INVALID_ARGUMENT', `Unknown event "${String(event)}"`);
      const entry = { handler };
      taskListeners.add(entry);
      detachTasks ??= hub.attach(onTaskEvent);
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        taskListeners.delete(entry);
        if (taskListeners.size === 0 && detachTasks !== null) {
          const detach = detachTasks;
          detachTasks = null;
          detach();
        }
      };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      taskListeners.clear();
      if (detachTasks !== null) {
        const detach = detachTasks;
        detachTasks = null;
        detach();
      }
      const failures = [...turnFailures];
      turnFailures.clear();
      for (const fail of failures) fail(new JunoError('CLOSED', 'The Juno client is closed'));
    },
  };
}
