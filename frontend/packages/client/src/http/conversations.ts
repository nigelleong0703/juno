import { z } from 'zod';

import type {
  ConversationsApi,
  ConversationsListParams,
  AguiResumeDecision,
  AguiResumeInput,
  ItemsApi,
  ItemsListParams,
} from '../contracts.js';
import type { ComposerPayload, Id, ResolveRequestInput, RunAgentInput, UpdateConversationInput } from '../contracts.js';
import {
  AGUI_PROTOCOL_VERSION,
  RunAgentInputSchema,
  conversationSchema,
  itemSchema,
  newAguiRunId,
  newAdmissionIdentity,
  resumeEntryForDecision,
} from '../contracts.js';
import type { HttpTransport } from './transport.js';

/** One transcript read: the newest items of a chat (the server allows up to 1000). */
const ITEMS_PAGE = 200;

type UserContent = Extract<RunAgentInput['messages'][number], { role: 'user' }>['content'];
type ContentPart = Exclude<UserContent, string>[number];

/** URL parts supplement the complete composer payload; private upload ids stay in forwardedProps. */
function userContentOf(payload: ComposerPayload): UserContent {
  if ((payload.attachments ?? []).length === 0) return payload.text;
  const parts: ContentPart[] = [{ type: 'text', text: payload.text }];
  for (const attachment of payload.attachments ?? []) {
    if (attachment.url === undefined) continue;
    const source = { type: 'url' as const, value: attachment.url, ...(attachment.mimeType === undefined ? {} : { mimeType: attachment.mimeType }) };
    parts.push(attachment.kind === 'image'
      ? { type: 'image', id: attachment.id, source }
      : { type: 'document', id: attachment.id, source });
  }
  return parts;
}

/** Chats and the message items inside them. */
export function createConversationsApi(http: HttpTransport): ConversationsApi {
  const runAgent = async (id: Id, input: RunAgentInput) => {
    const standard = RunAgentInputSchema.parse({
      ...input,
      threadId: id,
      protocolVersion: AGUI_PROTOCOL_VERSION,
      tools: input.tools,
      context: input.context,
    });
    const runResponseSchema = z.object({ item: z.unknown().optional(), runId: z.string().min(1) });
    const data = await http.request(
      `/v1/conversations/${id}/runs`,
      'POST',
      standard,
      runResponseSchema,
    );
    return {
      runId: data.runId,
      ...(data.item === undefined ? {} : { item: http.parse(itemSchema, data.item) }),
    };
  };

  const resume = async (id: Id, input: AguiResumeInput) => runAgent(id, {
    ...input,
    threadId: id,
    messages: input.messages ?? [],
    tools: input.tools ?? [],
    context: input.context ?? [],
  });

  return {
    async list(params?: ConversationsListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      if (params?.agentId) q.set('agentId', params.agentId);
      if (params?.kind) q.set('kind', params.kind);
      if (params?.memberId) q.set('memberId', params.memberId);
      return http.list(`/v1/conversations?${q.toString()}`, conversationSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/conversations/${id}`, 'GET');
      return http.parse(conversationSchema, data);
    },

    async create(input: unknown) {
      const data = await http.request(`/v1/conversations`, 'POST', input);
      return http.parse(conversationSchema, data);
    },

    /**
     * The newest page of a chat, in time order (as the iPhone reads it); `nextCursor` leads to older items.
     * The server's default is oldest-first with 50 rows, which dropped the latest messages of a long chat.
     */
    async items(id: Id, params?: ItemsListParams) {
      const q = new URLSearchParams({ order: 'desc', limit: String(params?.limit ?? ITEMS_PAGE) });
      if (params?.cursor) q.set('cursor', params.cursor);
      const page = await http.list(`/v1/conversations/${id}/items?${q.toString()}`, itemSchema);
      return { ...page, items: [...page.items].reverse() };
    },

    runAgent,

    resume,

    async resumeRequest(id: Id, requestId: Id, decision: ResolveRequestInput, runId?: Id) {
      return resume(id, {
        runId: runId ?? newAguiRunId(),
        resume: [resumeEntryForDecision(requestId, decision)],
      });
    },

    async resumeRequests(id: Id, decisions: AguiResumeDecision[], runId?: Id) {
      if (decisions.length === 0) throw new Error('A resume batch needs at least one interrupt');
      return resume(id, {
        runId: runId ?? newAguiRunId(),
        resume: decisions.map(({ requestId, decision }) => resumeEntryForDecision(requestId, decision)),
      });
    },

    /** The standard run entry: the whole composer payload travels in the standard user message/forwarded props. */
    async send(id: Id, payload: ComposerPayload, identity = newAdmissionIdentity()) {
      const result = await runAgent(id, {
        threadId: id,
        runId: identity.runId,
        protocolVersion: AGUI_PROTOCOL_VERSION,
        messages: [{ id: identity.messageId, role: 'user', content: userContentOf(payload) }],
        tools: [],
        context: [],
        forwardedProps: { juno: { composer: payload } },
      });
      if (result.item === undefined) throw new Error('The run entry did not return the stored user item');
      return { item: result.item, runId: result.runId };
    },

    async markRead(id: Id) {
      const data = await http.request(`/v1/conversations/${id}/mark-read`, 'POST');
      return http.parse(conversationSchema, data);
    },

    async update(id: Id, patch: UpdateConversationInput) {
      const data = await http.request(`/v1/conversations/${id}`, 'PATCH', patch);
      return http.parse(conversationSchema, data);
    },

    async delete(id: Id): Promise<void> {
      await http.request(`/v1/conversations/${id}`, 'DELETE');
    },

    async typing(id: Id, active: boolean): Promise<void> {
      await http.request(`/v1/conversations/${id}/typing`, 'POST', { active });
    },
  };
}

export function createItemsApi(http: HttpTransport): ItemsApi {
  return {
    async list(params?: ItemsListParams) {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.cursor) q.set('cursor', params.cursor);
      return http.list(`/v1/items?${q.toString()}`, itemSchema);
    },

    async get(id: Id) {
      const data = await http.request(`/v1/items/${id}`, 'GET');
      return http.parse(itemSchema, data);
    },
  };
}

