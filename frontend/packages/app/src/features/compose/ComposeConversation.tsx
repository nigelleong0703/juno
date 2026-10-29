import { Button, LoadingState, cn } from "@agent-desktop/ui";
import { useMemo } from "react";
import { Composer } from "../../components/conversation/Composer";
import { ModelProviderNotice } from "../../components/conversation/ModelProviderNotice";
import { useAgents, useConversations } from "../../data/queries";
import { noDragRegion } from "../../lib/drag";
import { t } from "../../lib/i18n";
import { broadcastCandidate } from "../../lib/mentions";
import { ComposeFirstAgent } from "./ComposeFirstAgent";
import { ComposeOptionsCard } from "./ComposeOptionsCard";
import { ComposeRecipientBar } from "./ComposeRecipientBar";
import { GROUP_MIN } from "./composeModel";
import { FIRST_AGENT_COPY } from "./firstAgentCopy";
import { useComposeEntry } from "./useComposeEntry";
import { useComposePicker } from "./useComposePicker";

/**
 * The "new message" draft (owner feedback 2026-10-05), modelled on the Bot setup
 * the owner verified: picking an existing agent jumps straight to its private
 * chat, the "Create new agent" row creates a blank agent (the server names it) and
 * opens its chat at once without a first message,
 * and an explicit "New group chat" entry switches to a
 * mode where members stay selected until the Create group button opens the room
 * (mention, so plain kickoff text wakes nobody until someone is @mentioned). The
 * bottom input is the shared Composer, kept with its draft on errors so a retry
 * never loses text.
 *
 * First-agent entry is authoritative: the agents list must load successfully
 * and be empty before the compact name-and-create onboarding appears, and it
 * renders alone — no recipient bar and no disabled composer behind it. Any
 * agents (or, while agentless, conversations) load failure offers a retry
 * only and never the creation form, so stale or failed data cannot enable a
 * first creation.
 */
export function ComposeConversation({ className }: { className?: string }) {
  const agentsQuery = useAgents();
  const conversationsQuery = useConversations();
  const agents = agentsQuery.data;
  const conversations = conversationsQuery.data;
  const agentsLoading = agentsQuery.isLoading;
  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );

  const entry = useComposeEntry({ conversations, agentById });
  const picker = useComposePicker({ agents, agentsLoading, agentById, conversations, entry });

  if (agentsLoading) return <LoadingState label={t("common.loading")} />;

  // Direct /new visits bypass the index: an agentless read must wait for the
  // conversations read as well, or a still-pending list could enable the
  // first creation before an existing history is known.
  if (picker.showFirstAgent && conversationsQuery.isLoading) {
    return <LoadingState label={t("common.loading")} />;
  }

  if (agentsQuery.isError || (picker.showFirstAgent && conversationsQuery.isError)) {
    const retry = () => {
      void agentsQuery.refetch();
      void conversationsQuery.refetch();
    };
    return (
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <div className="flex w-full max-w-xs flex-col items-center text-center">
            <p role="alert" className="text-sm text-fg-muted">
              {t("common.error")}
            </p>
            <Button variant="primary" size="sm" onClick={retry} className="mt-3">
              {t("common.retry")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (picker.showFirstAgent) {
    return (
      <div className={cn("flex h-full min-h-0 flex-col", className)}>
        <div className="flex min-h-0 flex-1 items-center justify-center px-4">
          <ComposeFirstAgent
            name={entry.firstAgentName}
            onNameChange={entry.setFirstAgentName}
            creating={entry.creatingAgent}
            onCreate={() => void entry.createAgentThenOpen(entry.firstAgentName)}
            error={entry.error}
            notice={<ModelProviderNotice className="mt-4 justify-center px-0 pb-0" />}
          />
        </div>
      </div>
    );
  }

  const composerDisabled =
    entry.busy !== null ||
    entry.creatingAgent ||
    entry.pending ||
    !picker.groupMode ||
    picker.selectedIds.length < GROUP_MIN;
  const showError = entry.error !== null || entry.sendFailed;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <ComposeRecipientBar
        groupMode={picker.groupMode}
        selectedAgents={picker.selectedAgents}
        onRemoveMember={picker.toggleMember}
        onExitGroupMode={picker.exitGroupMode}
        query={picker.query}
        onQueryChange={picker.onQueryChange}
        onFocusInput={picker.onFocusInput}
        inputRef={picker.inputRef}
        onEscape={picker.onEscape}
        onMoveCursor={picker.onMoveCursor}
        onEnter={picker.onEnter}
      />

      {picker.groupMode && (
        <div style={noDragRegion} className="px-4">
          <div className="mx-auto flex w-full max-w-[760px] items-center gap-2 pb-2">
            <span className="min-w-0 flex-1 truncate text-sm text-fg-muted">
              {FIRST_AGENT_COPY.newGroupChat} · {picker.selectedIds.length}{" "}
              {FIRST_AGENT_COPY.groupSelected}
            </span>
            <Button
              variant="primary"
              size="sm"
              disabled={
                !picker.canCreateGroup || entry.busy !== null || entry.creatingAgent || entry.pending
              }
              onClick={() => void entry.createGroup(picker.selectedIds)}
            >
              {entry.busy === "group"
                ? FIRST_AGENT_COPY.creatingGroup
                : FIRST_AGENT_COPY.createGroup + " (" + picker.selectedIds.length + ")"}
            </Button>
          </div>
        </div>
      )}

      {picker.open && (
        <ComposeOptionsCard
          groupMode={picker.groupMode}
          rows={picker.rows}
          safeCursor={picker.safeCursor}
          selectedIds={picker.selectedIds}
          agentById={agentById}
          onChoose={picker.choose}
          onHover={picker.onHoverRow}
        />
      )}

      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <p className="max-w-sm text-center text-sm text-fg-subtle">
          {picker.groupMode ? FIRST_AGENT_COPY.newGroupHint : t("compose.hint")}
        </p>
      </div>

      <div className="conversation-footer px-4 pb-3">
        <ModelProviderNotice className="px-0" />
        <div className="mx-auto w-full max-w-[760px]">
          <Composer
            agents={
              picker.groupMode
                ? [...(agents ?? []), broadcastCandidate(t("mention.allAgents"))]
                : (agents ?? [])
            }
            primaryAgent={picker.selectedAgents[0]}
            placeholder={
              picker.groupMode
                ? t("chat.placeholderGroup", { name: t("compose.agentPlaceholder") })
                : t("chat.placeholder", { name: t("compose.agentPlaceholder") })
            }
            disabled={composerDisabled}
            onSend={(payload) => entry.handleComposerSend(picker.selectedIds, payload)}
            clearOnSend={false}
          />
          {showError && (
            <div className="mt-2 flex items-center gap-2">
              <p role="alert" className="flex-1 text-sm text-fg-subtle">
                {entry.error ?? FIRST_AGENT_COPY.firstAgentSendFailed}
              </p>
              <Button
                variant="primary"
                onClick={() => entry.retryError(picker.selectedIds)}
                disabled={
                  entry.busy !== null || entry.creatingAgent || entry.pending || entry.retryKind === null
                }
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
