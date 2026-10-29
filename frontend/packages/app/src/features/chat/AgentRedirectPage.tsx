import { Button, EmptyState, LoadingState } from "@agent-desktop/ui";
import { useEffect, useMemo } from "react";
import { useNavigate, useParams } from "react-router";
import { useAgent, useConversations } from "../../data/queries";
import { t } from "../../lib/i18n";
import { AgentProfile } from "../agents/card/AgentProfile";
import { useComposeEntry } from "../compose/useComposeEntry";
import { findDirectConversationId } from "../conversation/ConversationContainer";

/**
 * `/agents/:agentId` (owner feedback 2026-10-05): an agent's page IS its conversation, so an agent with a direct chat
 * redirects to it. Only an exact direct chat with the agent is a target (a room or peer chat that merely contains the
 * agent must not stand in for it). Without one, the agent's page shows, with Start chat to open the 1:1.
 */
export function AgentRedirectPage() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const { data: conversations, isLoading } = useConversations(
    agentId ? { agentId, kind: "direct" } : undefined,
  );
  const { data: agent, isLoading: agentLoading } = useAgent(agentId);
  const agentById = useMemo(() => new Map(agent ? [[agent.id, agent]] : []), [agent]);
  const entry = useComposeEntry({ conversations, agentById });

  const directConversationId = findDirectConversationId(conversations, agentId ?? "");

  useEffect(() => {
    if (directConversationId) navigate(`/c/${directConversationId}`, { replace: true });
  }, [directConversationId, navigate]);

  if (isLoading || directConversationId || agentLoading) return <LoadingState label={t("common.loading")} />;
  if (!agent) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState centered title={t("empty.title")} />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col items-center gap-3 overflow-y-auto bg-bg px-4 py-8">
      <Button variant="primary" size="sm" disabled={entry.busy !== null} onClick={() => void entry.openDirect(agent.id)}>
        {t("agentCard.startChat")}
      </Button>
      {entry.error ? <p className="text-center text-sm text-danger">{entry.error}</p> : null}
      <AgentProfile agent={agent} className="h-fit w-full max-w-[660px] rounded-[28px] border border-border bg-bg shadow-sm" />
    </div>
  );
}
