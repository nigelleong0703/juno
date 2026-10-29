import type { Agent, CreateAgentInput } from "@agent-desktop/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useNavigate } from "react-router";
import { useClient } from "../../data/ClientProvider";

function newRequestId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
  return `req-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
}

/**
 * "＋" in the chat list: create a blank agent (SPEC 4.13 / 修订 v0.3) and open its
 * conversation straight away. The demo fixture seeds a direct conversation inside
 * `agents.create`; the live backend does not. Explicitly find the agent's direct
 * conversation and create one when it is missing instead of assuming the seed exists.
 */
export function useCreateAgentAndOpen() {
  const client = useClient();
  const qc = useQueryClient();
  const navigate = useNavigate();
  /**
   * A retry after a partial failure (agent created, conversation missing) must reuse
   * the agent and the conversation requestId — never create a second agent.
   * Keyed by the exact input so a new template choice starts fresh.
   */
  const attempt = useRef<{ key: string; agent: Agent; requestId: string } | null>(null);

  return useMutation({
    mutationKey: ["create-agent-and-open"],
    mutationFn: async (input: CreateAgentInput) => {
      const key = JSON.stringify(input);
      let active = attempt.current !== null && attempt.current.key === key ? attempt.current : null;
      if (active === null) {
        const agent = await client.agents.create(input);
        active = { key, agent, requestId: newRequestId() };
        attempt.current = active;
      }
      const agent = active.agent;
      const agentId = agent.id;
      // POST /v1/conversations never dedupes a direct by agent: look for the exact
      // 1:1 first (kind + sole membership) and create only when it is absent.
      const listed = await client.conversations.list({ agentId, kind: "direct" });
      const direct = listed.items.find(
        (entry) =>
          entry.kind === "direct" &&
          entry.agentIds.length === 1 &&
          entry.agentIds[0] === agentId,
      );
      if (direct) {
        attempt.current = null;
        return { agent, conversationId: direct.id };
      }
      const conversation = await client.conversations.create({
        kind: "direct",
        memberAgentIds: [agentId],
        requestId: active.requestId,
      });
      attempt.current = null;
      return { agent, conversationId: conversation.id };
    },
    onSuccess: ({ conversationId }) => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      if (conversationId) navigate(`/c/${conversationId}`);
    },
  });
}
