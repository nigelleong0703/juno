import { newAdmissionIdentity, type AdmissionIdentity } from "@agent-desktop/client";
import type {
  Attachment,
  ComposerPayload,
  CreateAgentInput,
  Idea,
  Item,
  Request,
  ResolveRequestInput,
  Today,
  UpdateAgentInput,
  UpdateConversationInput,
  UpdateSettingsInput,
} from "@agent-desktop/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useClient } from "./ClientProvider";
import { mergeItemChronologically, replaceOptimisticItem } from "./events";
import { qk } from "./keys";
import { useAuthIdentity, useCurrentUser } from "../auth/AuthContext";
import { sendFailureReason, useOutbox } from "./outbox";

/** Narrow a cached list-query key to its request filter without type casts. */
function requestListFilter(key: readonly unknown[]): {
  status?: string;
  kind?: string;
  agentId?: string;
} {
  const params = key[1];
  const filter: { status?: string; kind?: string; agentId?: string } = {};
  if (typeof params === "object" && params !== null) {
    for (const [name, value] of Object.entries(params)) {
      if (typeof value !== "string") continue;
      if (name === "status") filter.status = value;
      else if (name === "kind") filter.kind = value;
      else if (name === "agentId") filter.agentId = value;
    }
  }
  return filter;
}

/**
 * Approve / deny / answer a request (ARCHITECTURE section 7). The card never claims success
 * before the server answers: detail and list caches merge only on success from the authoritative
 * returned request, and a failure revalidates the singular detail so a stale row cannot stick.
 */
function withoutDecider({ by: _by, ...rest }: ResolveRequestInput): ResolveRequestInput {
  return rest;
}

export function useResolveRequest() {
  const identity = useAuthIdentity();
  const ownerId = identity?.mode === "account" ? identity.user.id : undefined;
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, decision }: { id: string; decision: ResolveRequestInput }) => {
      // An account session is the decider: the server knows who, so `by` is never sent. Every other field goes through as given.
      const body = ownerId ? withoutDecider(decision) : decision;
      const [request, pending] = await Promise.all([
        qc.getQueryData<Request>(qk.request(id)) ?? client.requests.get(id),
        client.requests.list({ status: "pending", limit: 200 }),
      ]);
      // A request without a run (an owner-claim question, a connect card) has no interrupted segment to resume.
      const { conversationId, runId } = request;
      if (conversationId === undefined || runId === undefined) return client.requests.resolve(id, body);
      const siblings = pending.items.filter((entry) =>
        entry.id !== id && entry.conversationId === conversationId && entry.runId === runId,
      );
      // A standard resume must answer the segment's whole pending interrupt set. One card cannot
      // fabricate the others, so multi-request segments use the retained product decision path.
      if (siblings.length > 0) return client.requests.resolve(id, body);
      await client.conversations.resumeRequest(conversationId, id, body, runId);
      return client.requests.get(id);
    },
    onSuccess: (returned, { id }) => {
      qc.setQueryData<Request>(qk.request(id), returned);
      for (const [key] of qc.getQueriesData<Request[]>({ queryKey: ["requests"] })) {
        const filter = requestListFilter(key);
        const matches =
          (!filter.status || filter.status === returned.status) &&
          (!filter.kind || filter.kind === returned.kind) &&
          (!filter.agentId || filter.agentId === returned.agentId);
        qc.setQueryData<Request[]>(key, (old) =>
          (old ?? []).flatMap((request) =>
            request.id !== id ? [request] : matches ? [returned] : [],
          ),
        );
      }
    },
    onError: (_error, { id }) => {
      void qc.invalidateQueries({ queryKey: qk.request(id) });
      void qc.invalidateQueries({ queryKey: ["requests"] });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["requests"] });
      void qc.invalidateQueries({ queryKey: ["runs"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });
}

/**
 * Accept (the server starts the agent on it; the returned idea carries the new `conversationId`) or dismiss an idea.
 * The row leaves every cached idea list once the server answers; `idea.updated` confirms it too.
 */
function useIdeaDecision(decide: (id: string) => Promise<Idea>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: decide,
    onSuccess: (returned) => {
      for (const [key] of qc.getQueriesData<Idea[]>({ queryKey: ["ideas"] })) {
        qc.setQueryData<Idea[]>(key, (old) => (old ?? []).filter((idea) => idea.id !== returned.id));
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["ideas"] });
    },
  });
}

export function useAcceptIdea() {
  const client = useClient();
  return useIdeaDecision((id) => client.ideas.accept(id));
}

/**
 * Feedback on an idea: "Not now" (`not_now`, snoozed two weeks, no rule) or "Less like this" (`less` / `never` with a scope;
 * the answer carries the rule written, which the caller can offer to undo). The idea leaves the open lists either way.
 */
export function useIdeaFeedback() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; action: "not_now" | "less" | "never"; scope?: "topic" | "type" }) =>
      client.proactive.feedback({
        target: { kind: "idea", id: input.id },
        action: input.action,
        ...(input.scope ? { scope: input.scope } : {}),
      }),
    onSuccess: (_result, { id }) => {
      for (const [key] of qc.getQueriesData<Idea[]>({ queryKey: ["ideas"] })) {
        qc.setQueryData<Idea[]>(key, (old) => (old ?? []).filter((idea) => idea.id !== id));
      }
      // Today's suggestions carry open ideas too: drop it there, or it reappears as a suggestion card.
      qc.setQueryData<Today>(qk.today(), (today) => today && { ...today, inspiration: today.inspiration.filter((card) => card.id !== id) });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["ideas"] });
      void qc.invalidateQueries({ queryKey: qk.today() });
      void qc.invalidateQueries({ queryKey: qk.proactiveRules() });
    },
  });
}

/** Remove a proactive rule (also the Undo of a "Less like this" press). */
export function useDeleteProactiveRule() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.proactive.deleteRule(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.proactiveRules() }),
  });
}

/** Keep a rule that is due for review; its review date moves 90 days on. */
export function useKeepProactiveRule() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.proactive.keepRule(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.proactiveRules() }),
  });
}

/** Send a message into a conversation; the reply run appears via the live event stream. */
export function useSendMessage(conversationId: string | undefined) {
  const owner = useCurrentUser();
  const client = useClient();
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ payload, identity }: { payload: ComposerPayload; identity: AdmissionIdentity }) =>
      client.conversations.send(conversationId as string, payload, identity),
    /**
     * The user's message renders on the same send path, instantly: a placeholder
     * joins the cached items and is swapped for the stored item on response. The
     * live echo merges by id, so no duplicate survives regardless of arrival
     * order. A refused send keeps its placeholder and is recorded in the outbox, so
     * the transcript offers Retry and Delete instead of silently dropping the text.
     */
    onMutate: async ({ payload, identity }) => {
      if (!conversationId) return { tempId: null, placeholder: null as Item | null };
      await qc.cancelQueries({ queryKey: qk.items(conversationId) });
      const tempId = identity.messageId;
      const placeholder: Item = {
        id: tempId,
        conversationId,
        at: new Date().toISOString(),
        type: "user_message",
        authorId: owner.id,
        text: payload.text,
        attachments: payload.attachments ?? [],
        mentions: payload.mentions ?? [],
      };
      qc.setQueryData<Item[]>(qk.items(conversationId), (old) =>
        mergeItemChronologically(old ?? [], placeholder),
      );
      return { tempId, placeholder };
    },
    onError: (error, { payload, identity }, context) => {
      const tempId = context?.tempId;
      const placeholder = context?.placeholder;
      if (!conversationId || !tempId || !placeholder) return;
      useOutbox.getState().markFailed({
        tempId,
        identity,
        conversationId,
        payload,
        reason: sendFailureReason(error),
        item: placeholder,
      });
    },
    onSuccess: (result, _payload, context) => {
      const tempId = context?.tempId;
      if (conversationId && tempId) {
        useOutbox.getState().forget(tempId);
        qc.setQueryData<Item[]>(qk.items(conversationId), (old) =>
          replaceOptimisticItem(old ?? [], tempId, result.item),
        );
      }
      void qc.invalidateQueries({ queryKey: qk.items(conversationId ?? "") });
      void qc.invalidateQueries({ queryKey: ["runs"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });
  // Allocate once per explicit send intent, before React Query can retry the network call.
  return {
    ...mutation,
    mutate: (payload: ComposerPayload) => mutation.mutate({ payload, identity: newAdmissionIdentity() }),
    mutateAsync: (payload: ComposerPayload) => mutation.mutateAsync({ payload, identity: newAdmissionIdentity() }),
    retry: (tempId: string) => {
      const failed = useOutbox.getState().failed[tempId];
      if (failed === undefined || failed.conversationId !== conversationId) return;
      mutation.mutate({ payload: failed.payload, identity: failed.identity });
    },
  };
}
/**
 * Removes an optimistic message from the transcript and forgets its failure: the Delete action,
 * and the first half of Retry (the send itself then creates a fresh placeholder).
 */
export function useDiscardSend(conversationId: string | undefined) {
  const qc = useQueryClient();
  return (tempId: string) => {
    useOutbox.getState().forget(tempId);
    if (!conversationId) return;
    qc.setQueryData<Item[]>(qk.items(conversationId), (old) =>
      (old ?? []).filter((entry) => entry.id !== tempId),
    );
  };
}

export function useMarkConversationRead() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.conversations.markRead(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/** Per-chat flags (pinned, muted) are server state; the reply and `conversation.updated` settle the cache. */
export function useUpdateConversation() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateConversationInput }) =>
      client.conversations.update(id, patch),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/** Delete one chat and its history (never the agent). */
export function useDeleteConversation() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.conversations.delete(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/**
 * H-93: request a stop. The server only signals the run; the run finalizes itself and the live
 * run.finished event updates the UI, so nothing here pretends it already stopped.
 */
export function useStopRun() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => client.runs.stop(runId),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["runs"] }),
  });
}

export function useToggleRoutine() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled?: boolean }) =>
      client.routines.toggle(id, enabled),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["routines"] }),
  });
}

/** Install / uninstall a plugin (§4.10). */
export function usePluginInstall() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, installed }: { id: string; installed: boolean }) =>
      installed ? client.plugins.uninstall(id) : client.plugins.install(id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["plugins"] });
      void qc.invalidateQueries({ queryKey: ["apps"] });
    },
  });
}

/** Accept or dismiss an agent-drafted rule (§4.7). */
export function useRuleDraft() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, accept }: { id: string; accept: boolean }) => {
      if (accept) await client.rules.acceptDraft(id);
      else await client.rules.rejectDraft(id);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

/**
 * Patch app settings (§4.14). Pessimistic by design: the old shallow optimistic merge
 * ({...old, ...patch}) destroyed nested siblings on deep-partial patches, showed a
 * serverDefault the server never confirmed, and never rolled back. Callers that need
 * instant UI (theme) run their own dedicated optimistic flow with rollback; every save
 * lands the authoritative returned settings in the cache and revalidates afterwards.
 */
export function useUpdateSettings() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateSettingsInput) => client.settings.update(patch),
    onSuccess: (returned) => {
      qc.setQueryData(qk.settings(), returned);
    },
    onError: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

/** Create a new agent (§4.13). */
export function useCreateAgent() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInput) => client.agents.create(input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/** Rename / re-avatar / pin an agent (§4.12) with an optimistic cache write. */
export function useUpdateAgent() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateAgentInput }) =>
      client.agents.update(id, patch),
    onMutate: ({ id, patch }) => {
      qc.setQueriesData<{ id: string }[]>({ queryKey: ["agents"] }, (old) =>
        old?.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)),
      );
    },
    onSuccess: (agent) => qc.setQueryData(qk.agent(agent.id), agent),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/** Pause (no routine, webhook or wake starts a run) or resume an agent (F-09). The buttons follow `pausedAt`, not `status`. */
export function useSetAgentPaused() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, paused }: { id: string; paused: boolean }) => (paused ? client.agents.pause(id) : client.agents.resume(id)),
    onSuccess: (agent) => qc.setQueryData(qk.agent(agent.id), agent),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

/** Stop every active run of an agent, child runs included (F-09); the live run events update the lists. */
export function useStopAgent() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.agents.stop(id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["runs"] }),
  });
}

/** Accept or dismiss the agent's suggested role (BACKEND §10.11); the agent list refreshes on settle. */
export function useAcceptRoleSuggestion() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.agents.acceptRoleSuggestion(id),
    onSuccess: (agent) => qc.setQueryData(qk.agent(agent.id), agent),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useDismissRoleSuggestion() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.agents.dismissRoleSuggestion(id),
    onSuccess: (agent) => qc.setQueryData(qk.agent(agent.id), agent),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["agents"] }),
  });
}

export function useDeleteAgent() {
  const client = useClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.agents.delete(id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}

/** Base64 of a file's bytes, in chunks so a large file does not overflow the argument list. */
async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/**
 * Upload a picked file (POST /v1/uploads) and return the attachment a message carries. A message may only
 * reference uploaded files; the server refuses anything else (ATTACHMENT_NOT_FOUND).
 */
export function useUploadFile(): (file: File) => Promise<Attachment> {
  const client = useClient();
  return async (file: File) =>
    client.library.upload({ name: file.name, mimeType: file.type, contentBase64: await fileBase64(file) });
}
