import { randomUUID } from 'node:crypto';

/** Build a real RunAgentInput for route/scenario fixtures, keeping the whole composer payload. */
export function aguiInput(path: string, composer: unknown): Record<string, unknown> {
  const threadId = /\/v1\/conversations\/([^/]+)\/runs/.exec(path)?.[1];
  if (threadId === undefined) throw new Error('Expected a conversation run path');
  const text = typeof composer === 'object' && composer !== null ? Reflect.get(composer, 'text') : undefined;
  return {
    threadId, runId: 'run-test-' + randomUUID(), state: {}, tools: [], context: [],
    messages: [{ id: 'msg-test-' + randomUUID(), role: 'user', content: typeof text === 'string' ? text : '' }],
    forwardedProps: { juno: { composer } },
  };
}
