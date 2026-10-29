import type { ComposerPayload, CreateConversationInput } from "@agent-desktop/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useClient } from "../../data/ClientProvider";
import type { ComposeRecipient } from "../../store/ui";

export interface StartConversationInput {
  recipients: ComposeRecipient[];
  payload: ComposerPayload;
}

function intentSignature(recipients: ComposeRecipient[], payload: ComposerPayload): string {
  const parts = recipients.map((recipient) =>
    recipient.agentId ? `a:${recipient.agentId}` : `n:${recipient.key}:${recipient.name}`,
  );
  const attachments = (payload.attachments ?? [])
    .map((attachment) => `${attachment.name}:${attachment.sizeBytes ?? 0}`)
    .join(",");
  const mentions = (payload.mentions ?? [])
    .map((mention) => `${mention.kind}:${mention.id}`)
    .join(",");
  return `${parts.join(",")}|${payload.text}|${attachments}|${mentions}`;
}

function newRequestId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return `req-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
}

/**
 * Turns an unsent draft into a real conversation (owner feedback 2026-10-05):
 *
 *  - a "new" recipient becomes an agent first (`agents.create`);
 *  - one recipient → look up the exact 1:1 (kind direct, sole membership) first and
 *    send there; create with `firstMessage` only when it is absent (POST never
 *    dedupes a direct by agent, it only dedupes `requestId`);
 *  - several recipients → `conversations.create({ kind: "room" })`, a new group
 *    thread titled from its members;
 *
 * A created thread carries the first message as part of the same call
 * (`firstMessage`), so the thread the app navigates to already holds it.
 * `conversation.created` lands in liveSync and the chat list.
 *
 * Each distinct draft intent (recipients + payload) gets one `requestId`
 * (`crypto.randomUUID`), reused across retries of the same intent so the backend can dedupe;
 * editing the intent replaces the key and success discards it. Agents already created for a
 * "new" recipient key are reused on retry instead of duplicated. The stable `mutationKey`
 * keeps the pending mutation identifiable in the cache.
 */
export function useStartConversation() {
  const client = useClient();
  const qc = useQueryClient();

  const intentSlot = useRef<{ signature: string; requestId: string } | null>(null);
  const createdAgents = useRef(new Map<string, string>());

  return useMutation({
    mutationKey: ["start-conversation"],
    mutationFn: async ({ recipients, payload }: StartConversationInput): Promise<string> => {
      if (recipients.length === 0) throw new Error("no recipients");
      const signature = intentSignature(recipients, payload);
      let active = intentSlot.current;
      if (!active || active.signature !== signature) {
        active = { signature, requestId: newRequestId() };
        intentSlot.current = active;
      }
      const requestId = active.requestId;

      const memberAgentIds: string[] = [];
      for (const recipient of recipients) {
        if (recipient.agentId) {
          memberAgentIds.push(recipient.agentId);
          continue;
        }
        const reused = createdAgents.current.get(recipient.key);
        if (reused) {
          memberAgentIds.push(reused);
          continue;
        }
        const agent = await client.agents.create(recipient.name ? { name: recipient.name } : {});
        createdAgents.current.set(recipient.key, agent.id);
        memberAgentIds.push(agent.id);
      }

      // `requestId` is the idempotency key the backend recovery path dedupes on.
      // Rooms the user creates explicitly default to `mention` (GH2 group UX):
      // plain kickoff text wakes nobody until someone is @mentioned, so group
      // delivery never surprises. `roomMode` rides a spread: the backend accepts
      // it while the shared CreateConversationInput interface stays untouched.
      const MENTION = "mention";
      const roomExtras = recipients.length > 1 ? { roomMode: MENTION } : {};
      if (memberAgentIds.length === 1 && memberAgentIds[0] !== undefined) {
        const agentId = memberAgentIds[0];
        const listed = await client.conversations.list({ agentId, kind: "direct" });
        const direct = listed.items.find(
          (entry) =>
            entry.kind === "direct" &&
            entry.agentIds.length === 1 &&
            entry.agentIds[0] === agentId,
        );
        if (direct !== undefined) {
          await client.conversations.send(direct.id, payload);
          intentSlot.current = null;
          return direct.id;
        }
      }
      const body: CreateConversationInput = {
        kind: recipients.length > 1 ? "room" : "direct",
        memberAgentIds,
        // The room carries its members' actual display names (verified in CX runtime).
        ...(recipients.length > 1
          ? { title: recipients.map((recipient) => recipient.name).join(", ") }
          : {}),
        firstMessage: payload,
        requestId,
        ...roomExtras,
      };
      const conversation = await client.conversations.create(body);
      intentSlot.current = null;
      return conversation.id;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
  });
}
