import { useParams } from "react-router";
import { useAgent } from "../../data/queries";
import { t } from "../../lib/i18n";
import { AgentProfile } from "./card/AgentProfile";

/**
 * Per-agent page (MUSE-PARITY step 7): the agent panel (the same one the chat header's dropdown shows), full page, centered. Every
 * section slug (`/agents/:id/settings/:section?`) shows the same panel so old links keep working;
 * identity editing lives in the panel's Memory tab, read-only for agents someone else created.
 */
export function AgentSettingsPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const { data: agent, isLoading } = useAgent(agentId);

  return (
    <div className="flex h-full min-h-0 justify-center overflow-y-auto bg-bg px-4 py-8">
      {isLoading || !agent ? (
        <p className="text-sm text-fg-muted">{t("common.loading")}</p>
      ) : (
        <AgentProfile agent={agent} className="h-fit w-full max-w-[660px] rounded-[28px] border border-border bg-bg shadow-sm" />
      )}
    </div>
  );
}
