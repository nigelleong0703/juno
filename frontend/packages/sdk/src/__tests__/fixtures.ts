/** Schema-valid wire objects for the fake backend. The client validates every event, so these must match the contracts. */

import { EventType } from '@agent-desktop/client';

const NOW = '2026-10-26T09:00:00.000Z';

export const AGENT_ID = 'agent-a';

export function conversation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'direct',
    agentIds: [AGENT_ID],
    memberIds: ['owner'],
    unreadCount: 0,
    lastItemAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

export function run(id: string, conversationId: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    agentId: AGENT_ID,
    conversationId,
    title: 'Reply to the owner',
    status,
    kind: 'chat',
    steps: [],
    usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
    startedAt: NOW,
    lastActivityAt: NOW,
    ...overrides,
  };
}

export function step(id: string, runId: string, status: string, tool = 'shell') {
  return {
    id,
    runId,
    index: 0,
    kind: 'shell',
    verb: 'Ran',
    target: 'ls',
    status,
    startedAt: NOW,
    durationMs: 0,
    tool,
  };
}

export function userMessage(id: string, conversationId: string, text: string) {
  return {
    type: 'user_message',
    id,
    conversationId,
    at: NOW,
    authorId: 'owner',
    text,
    attachments: [],
    mentions: [],
  };
}

export function agentMessage(id: string, conversationId: string, markdown: string, runId?: string) {
  return {
    type: 'agent_message',
    id,
    conversationId,
    at: NOW,
    agentId: AGENT_ID,
    ...(runId ? { runId } : {}),
    markdown,
    citations: [],
  };
}

export function request(id: string, conversationId: string | undefined, runId: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'approval',
    status,
    title: 'Send an email',
    summary: 'Reply to Alex',
    agentId: AGENT_ID,
    ...(conversationId ? { conversationId } : {}),
    runId,
    payload: { kind: 'approval', action: 'Send email', why: 'The owner asked for a reply' },
    createdAt: NOW,
    ...overrides,
  };
}

export function task(id: string, status: 'running' | 'ended', outcome?: 'done' | 'failed') {
  return {
    id,
    agentId: AGENT_ID,
    kind: 'command',
    rootRunId: 'run-root',
    depth: 0,
    origin: { type: 'owner_message', conversationId: 'conv-1' },
    mode: 'background',
    replyTo: { type: 'none' },
    title: 'Run the test suite',
    status,
    ...(outcome ? { outcome } : {}),
    startedAt: NOW,
    updatedAt: NOW,
  };
}

export function preview(
  fields: { generationId: number; seq: number; phase: 'start' | 'delta' | 'discard' | 'final' | 'reset'; runId: string; conversationId: string; messageId: string; text?: string },
) {
  const messageId = fields.messageId.startsWith('preview_') ? fields.messageId : 'preview_' + fields.messageId;
  const metadata = { juno: {
    agentId: AGENT_ID,
    conversationId: fields.conversationId,
    runId: fields.runId,
    generationId: fields.generationId,
    seq: fields.seq,
    attemptId: messageId.slice('preview_'.length),
  } };
  if (fields.phase === 'start') return { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant', metadata };
  if (fields.phase === 'delta') return { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: fields.text ?? '', metadata };
  if (fields.phase === 'final') return { type: EventType.TEXT_MESSAGE_END, messageId, metadata };
  return { type: EventType.CUSTOM, name: 'juno.preview.closed', value: { messageId, runId: fields.runId, generationId: fields.generationId, scope: fields.phase === 'discard' ? 'attempt' : 'generation' }, metadata };
}

export function runStarted(value: ReturnType<typeof run>) {
  return { type: EventType.RUN_STARTED, threadId: value.conversationId, runId: value.id, metadata: { juno: { agentId: value.agentId, conversationId: value.conversationId, runId: value.id } } };
}

export function runUpdated(value: ReturnType<typeof run>) {
  return { type: EventType.CUSTOM, name: 'juno.run.updated', value, metadata: { juno: { agentId: value.agentId, conversationId: value.conversationId, runId: value.id, runStatus: value.status } } };
}

export function runFinished(value: ReturnType<typeof run>) {
  const outcome = value.status === 'stopped' ? { type: 'cancelled' as const } : { type: 'success' as const };
  return { type: EventType.RUN_FINISHED, threadId: value.conversationId, runId: value.id, outcome, metadata: { juno: { agentId: value.agentId, conversationId: value.conversationId, runId: value.id, runStatus: value.status } } };
}

export function stepStarted(value: ReturnType<typeof step>) {
  return { type: EventType.STEP_STARTED, stepName: value.tool ?? value.verb, metadata: { juno: { runId: value.runId, stepId: value.id } } };
}

export function stepFinished(value: ReturnType<typeof step>) {
  return { type: EventType.STEP_FINISHED, stepName: value.tool ?? value.verb, metadata: { juno: { runId: value.runId, stepId: value.id } } };
}
