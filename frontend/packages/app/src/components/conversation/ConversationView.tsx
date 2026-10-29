import type { Agent, Attachment, ComposerPayload, Conversation, Item, Request, Run } from "@agent-desktop/client";
import {
  EmptyState,
  ErrorState,
  IconButton,
  LoadingState,
  cn,
} from "@agent-desktop/ui";
import { AgentBubble } from "../agent/AgentBubble";
import { ChevronDown, MessageSquare, Monitor, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useUiStore } from "../../store/ui";
import { t } from "../../lib/i18n";
import { dragRegion, noDragRegion } from "../../lib/drag";
import { useOutbox, withRefused } from "../../data/outbox";
import { useStreamConnected } from "../../data/connection";
import { agentStatus } from "./deliveryState";
import { ChannelBadge, channelPlatformName } from "../channel/platforms";
import { AgentStatusPill } from "./AgentStatusPill";
import { agentAccentStyle } from "../../lib/avatars";
import { resolveDoingLine } from "../../lib/doingLine";
import { AgentAvatar } from "../agent/AgentAvatar";
import { AgentAvatarGroup } from "../agent/AgentAvatarGroup";
import { Composer } from "./Composer";
import type { ReplyTarget } from "./MessageMenu";
import { quotePrefix } from "../../lib/quote";
import { agentStatusMeta } from "../../lib/status";
import { Transcript, conversationColumn } from "./Transcript";
import { useTypingActivity } from "../../data/typing";
import { canStopRun } from "../../data/child-runs";
import { broadcastCandidate } from "../../lib/mentions";

export interface ConversationViewProps {
  /** The loaded conversation; absent while loading or after an error. */
  conversation?: Conversation;
  /** True while a request that needs the owner (not an inline question/connect card) waits in this chat. */
  waitingOnYou?: boolean;
  /** Uploads a picked file for the composer (POST /v1/uploads). */
  onUploadFile?: (file: File) => Promise<Attachment>;
  items?: Item[];
  itemsLoading?: boolean;
  /** Every agent in the workspace; used to resolve participants and authors. */
  agents?: Agent[];
  /** The answering agent, fetched on its own (may differ from the workspace list). */
  primaryAgent?: Agent;
  /**
   * The conversation's runs as the API returns them (H-94: any status, not only "running"); may
   * include runs from other conversations. The view picks this chat's live run itself.
   */
  runningRuns?: Run[];
  isLoading: boolean;
  isError: boolean;
  /** A send is in flight (disables the composer). */
  sending?: boolean;
  computerPanelOpen: boolean;
  onRetry: () => void;
  onSend: (payload: ComposerPayload) => void;
  /** Resend a refused message (its placeholder id) with the same payload. */
  onRetrySend?: (tempId: string) => void;
  /** Remove a refused message from the transcript. */
  onDeleteSend?: (tempId: string) => void;
  onToggleComputerPanel: () => void;
  onOpenRun?: (runId: string) => void;
  /** H-93: stop a run of this chat (composer Stop control and run cards). */
  onStopRun?: (runId: string) => void;
  onOpenRoutine?: (routineId: string) => void;
  onOpenSignin?: (request: Request) => void;
  /** Mention Message action; absent hides the button. Wired by the container. */
  onOpenAgent?: (agentId: string) => void;
  /** Dispatches a system item's action command (e.g. `computer.open`). */
  onSystemAction?: (command: string) => void;
  onOpenCitation: (url: string) => void;
  /** Optional line directly above the agent-status pill (e.g. the model-provider setup notice). */
  footerNotice?: ReactNode;
  /** Wraps the header's avatar button in the agent management dropdown (features own it); bare button when absent. */
  agentPanel?: (trigger: ReactElement) => ReactNode;
  className?: string;
}

/** Persistent presence under the agent's name (iPhone): reconnecting/working, else what it is doing, else its status word. */
function AgentPresence({ agent, runs, override }: { agent: Agent; runs: readonly Run[] | undefined; override: string | undefined }) {
  const doing = resolveDoingLine({ agentId: agent.id, status: agent.status, agentDoing: agent.doing, runs });
  return (
    <span data-slot="agent-presence" className="max-w-full truncate text-xs leading-tight text-fg-muted">
      {override ?? doing ?? t(agentStatusMeta[agent.status].label)}
    </span>
  );
}

/**
 * A whole conversation (§4.3), rendered from typed data and action callbacks: a header with the
 * agent's identity, status line and controls, the transcript of every Item type, and the
 * composer. Rooms show every participant; direct chats show one agent.
 *
 * Data, routing and UI-store orchestration live in `features/conversation/ConversationContainer`;
 * this view only decides what to render.
 */
export function ConversationView({
  onUploadFile,
  conversation,
  waitingOnYou,
  items,
  itemsLoading,
  agents,
  primaryAgent,
  runningRuns,
  isLoading,
  isError,
  sending,
  computerPanelOpen,
  onRetry,
  onSend,
  onRetrySend,
  onDeleteSend,
  onToggleComputerPanel,
  onOpenRun,
  onStopRun,
  onOpenRoutine,
  onOpenSignin,
  onOpenAgent,
  onSystemAction,
  onOpenCitation,
  footerNotice,
  agentPanel,
  className,
}: ConversationViewProps) {
  const agentById = useMemo(
    () => (id: string) => agents?.find((agent) => agent.id === id),
    [agents],
  );

  const participants = useMemo(
    () =>
      conversation
        ? conversation.agentIds.flatMap((id) => agents?.find((a) => a.id === id) ?? [])
        : [],
    [conversation, agents],
  );

  // Owner feedback (UF6): the computer toggle reflects the EFFECTIVE displayed pane —
  // never the raw persisted pref, which claims an open pane on routes with no
  // conversation or agent. Before the shell's first layout snapshot, fall back to the
  // effective value computed here.
  const layoutSynced = useUiStore((state) => state.layoutSynced);
  const displayedComputerOpen = useUiStore((state) => state.displayedComputerOpen);
  const effectiveComputerOpen =
    computerPanelOpen && Boolean(conversation?.agentIds[0]) && Boolean(conversation?.id);
  const computerOpen = layoutSynced ? displayedComputerOpen : effectiveComputerOpen;
  // The right pane is the workspace only; the computer button toggles it. The avatar opens the agent's
  // management dropdown (the injected `agentPanel` slot, since this view must not import features).
  const openWorkspace = useUiStore((state) => state.openWorkspace);

  // The message being replied to; sending quotes it ("> line" prefix, same as the iPhone app) and ends the reply.
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const replyConversation = useRef(conversation?.id);
  if (replyConversation.current !== conversation?.id) {
    replyConversation.current = conversation?.id;
    if (reply !== null) setReply(null);
  }
  const handleSend = (payload: ComposerPayload) => {
    onSend(reply?.text.trim() ? { ...payload, text: quotePrefix(reply.text) + payload.text } : payload);
    setReply(null);
  };
  /** Typing pings only an existing private thread; drafts and rooms stay silent. */
  const typingId = conversation?.kind === "direct" ? conversation.id : undefined;
  const typing = useTypingActivity(typingId);
  const handleComposerSend = (payload: ComposerPayload) => {
    typing.stopTyping();
    handleSend(payload);
  };
  const isGroup = conversation?.kind === "room" || conversation?.kind === "peer";
  const workspaceShown = computerOpen;
  const withAgentPanel = (trigger: ReactElement): ReactNode => agentPanel?.(trigger) ?? trigger;
  // An accepted idea (planned home page) opens this chat with its text in the composer. The key
  // below remounts the composer once the text is known; leaving the chat drops the leftover text.
  const composerPrefill = useUiStore((state) => state.composerPrefill);
  const setComposerPrefill = useUiStore((state) => state.setComposerPrefill);
  const prefillText =
    conversation && composerPrefill?.conversationId === conversation.id ? composerPrefill.text : undefined;
  // Drop leftover text only on a real unmount. StrictMode runs effect cleanups on mount too, so the
  // clear waits a microtask and skips when the effect has come back (otherwise Ideas and Discuss
  // drafts vanish in development).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) setComposerPrefill(null);
      });
    };
  }, [setComposerPrefill]);
  // The runs list is not always conversation-scoped, so match explicitly (owner feedback
  // 2026-10-05: a blank agent must never show another agent's run in its header).
  // H-94: Stop is offered for every live run of this chat, including one waiting for the user's
  // approval or answer (waiting_for_input) and one still queued; finished runs never match.
  // Child runs share the chat's conversation id, so the chat's own top-level run wins over them.
  const liveRuns = (runningRuns ?? []).filter(
    (run) => run.conversationId === conversation?.id && canStopRun(run.status),
  );
  const stoppableRun = liveRuns.find((run) => run.parentRunId === undefined) ?? liveRuns[0];
  // The "agent is replying" bubble and typing reflect only work the agent is doing right now:
  // a run waiting on the user, or still queued, is not the agent replying.
  const replyingRun = (runningRuns ?? []).find(
    (run) => run.conversationId === conversation?.id && run.status === "running",
  );
  // The agent-status pill above the composer, and the refused-send marks (both web-only state).
  const failedSends = useOutbox((state) => state.failed);
  const streamConnected = useStreamConnected();
  // Refused messages stay in the transcript even when a refetch no longer returns them.
  const shownItems = withRefused(items ?? [], failedSends, conversation?.id);
  const refused = Object.fromEntries(
    Object.values(failedSends)
      .filter((entry) => entry.conversationId === conversation?.id)
      .map((entry) => [entry.tempId, entry.reason]),
  );
  const status = agentStatus({
    runs: runningRuns ?? [],
    conversationId: conversation?.id,
    failed: failedSends,
    connected: streamConnected,
  });
  // Persistent presence under the agent's name (iPhone parity): reconnecting, what it is doing, or its status.
  const presenceOverride = status?.kind === "reconnecting" ? t("agentStatus.reconnecting") : undefined;
  // The typing bubble is the only working indicator: from send until the run ends, under the newest message
  // (interim replies included). A run waiting for the owner is not "replying": its request card shows instead,
  // and the bubble returns when the run is running again.
  const awaitingReply = sending === true || Boolean(replyingRun);
  // The agent is writing the chat's first words (its greeting): the typing dots stand in for the empty state.
  const greeting = shownItems.length === 0 && (Boolean(replyingRun) || primaryAgent?.status === "working");
  const groupFallback =
    isGroup && participants.length > 0
      ? participants.map((participant) => participant.name).join(", ")
      : undefined;
  // A direct chat takes the agent's character colour (user bubble, send button); groups stay neutral.
  const accent = isGroup ? undefined : primaryAgent;
  const title = conversation?.title ?? groupFallback ?? primaryAgent?.name ?? t("chat.untitled");
  // Scroll under composer (UI92): the transcript keeps scrolling behind the
  // composer, so its bottom padding must equal the real (multiline/attachment)
  // footer height plus the 64px fade. One ResizeObserver writes that height to a
  // CSS var on the shared thread body; CSS owns the layout, no per-frame render.
  const threadBodyRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const body = threadBodyRef.current;
    const footer = footerRef.current;
    if (body === null || footer === null) return;
    const write = (): void => {
      body.style.setProperty("--conversation-footer-height", `${footer.offsetHeight}px`);
    };
    write();
    const observer = new ResizeObserver(write);
    observer.observe(footer);
    return () => observer.disconnect();
    // `isLoading`/`isError` gate the early returns, so with a stable conversation id
    // the refs are still null on the first run and only attach once the body mounts:
    // they must retrigger the effect, or the observer would never start.
  }, [conversation?.id, isLoading, isError]);

  if (isLoading) return <LoadingState label={t("common.loading")} />;
  if (isError || !conversation) {
    return <ErrorState title={t("common.error")} onRetry={onRetry} />;
  }

  // The identity capsule keeps presence below the name; detailed run state stays
  // in the computer pane. `stoppableRun` drives the composer's Stop control (H-94).

  return (
    <div
      className={cn("conversation-view relative isolate flex h-full min-h-0 flex-col", className)}
      style={accent ? agentAccentStyle(accent.id, accent.avatar) : undefined}
    >
      <header
        style={dragRegion}
        data-titlebar
        data-slot="conversation-header"
        className="conversation-header grid h-[120px] shrink-0 select-none grid-cols-[1fr_auto_1fr] items-start gap-2 px-3"
      >
        <div
          aria-hidden
          data-slot="conversation-header-fade"
          className="conversation-header-fade"
        />
        <div aria-hidden className="min-w-0" />
        <div className="flex min-w-0 justify-center pt-1">
          {isGroup ? (
            participants.length > 0 ? (
              withAgentPanel(
                <button
                  type="button"
                  data-slot="agent-header-trigger"
                  aria-label={t("agentPanel.groupOpen")}
                  title={t("agentPanel.groupOpen")}
                  style={noDragRegion}
                  className="flex min-w-0 max-w-full flex-col items-center justify-center gap-0.5 px-2 focus-ring"
                >
                  <AgentAvatarGroup agents={participants} size={64} max={2} label={title} />
                  <span className="flex max-w-56 items-center gap-1 rounded-full border border-border bg-muted px-2 py-px text-sm font-medium leading-tight text-fg">
                    <span role="heading" aria-level={1} className="min-w-0 truncate">{title}</span>
                    <ChevronDown className="size-3 shrink-0 text-fg-muted" />
                  </span>
                </button>,
              )
            ) : (
              <span className="flex size-6 items-center justify-center text-fg-muted">
                <Users className="size-4" />
              </span>
            )
          ) : primaryAgent ? (
            withAgentPanel(
              <button
                type="button"
                data-slot="agent-header-trigger"
                aria-label={t("agentPanel.open", { name: primaryAgent.name })}
                title={t("agentPanel.open", { name: primaryAgent.name })}
                style={noDragRegion}
                className="flex min-w-0 max-w-full flex-col items-center justify-center gap-0.5 px-2 focus-ring"
              >
                <AgentBubble
                  heading
                  media={<AgentAvatar agentId={primaryAgent.id} avatar={primaryAgent.avatar} status={primaryAgent.status} needsYou={(waitingOnYou ?? (conversation.needsYou ?? 0) > 0) || primaryAgent.status === "needs_you"} size={60} />}
                  name={primaryAgent.name}
                  below={<AgentPresence agent={primaryAgent} runs={runningRuns} override={presenceOverride} />}
                />
                {conversation.channel && <ChannelBadge kind={conversation.channel.kind} />}
              </button>,
            )
          ) : (
            <span className="flex size-6 items-center justify-center text-fg-muted">
              <MessageSquare className="size-4" />
            </span>
          )}
        </div>

        <div className="flex items-start justify-end gap-1 pt-2">
          <IconButton
            style={noDragRegion}
            label={workspaceShown ? t("chat.computer.hide") : t("chat.computer.show")}
            variant={workspaceShown ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={workspaceShown}
            onClick={() => (workspaceShown ? onToggleComputerPanel() : openWorkspace(isGroup ? (primaryAgent ?? participants[0])?.id : null))}
          >
            <Monitor />
          </IconButton>
        </div>
      </header>

      {/* Shared positioning body (UI92): the transcript and the footer are two cells of
          the same 1x1 grid, so the message list keeps scrolling behind the pill instead
          of ending at the footer's top edge. */}
      <div
        ref={threadBodyRef}
        data-slot="conversation-thread-body"
        className="conversation-thread-body"
      >
        {itemsLoading ? (
          <LoadingState label={t("common.loading")} />
        ) : shownItems.length > 0 || greeting ? (
          <Transcript
            items={shownItems}
            showAwaiting={awaitingReply || greeting}
            awaitingRunId={replyingRun?.id}
            agentById={agentById}
            agents={agents}
            showAuthors={isGroup}
            emptyName={primaryAgent?.name}
            primaryAgentName={primaryAgent?.name}
            onOpenRun={onOpenRun}
            onStopRun={onStopRun}
            onOpenRoutine={onOpenRoutine}
            onOpenSignin={onOpenSignin}
            onOpenAgent={onOpenAgent}
            onSystemAction={onSystemAction}
            onOpenCitation={onOpenCitation}
            refused={refused}
            onReply={setReply}
            onRetrySend={onRetrySend}
            onPickReply={(text) => handleSend({ text })}
          />
        ) : (
          <div data-slot="conversation-empty" className="flex min-h-0 items-center justify-center">
            <EmptyState centered
              title={t("transcript.empty")}
              description={isGroup ? t("transcript.emptyGroupHint") : t("transcript.emptyHint", { name: primaryAgent?.name ?? title })}
            />
          </div>
        )}

        {/* Positioning anchor for the absolute `.composer-fade` overlay and the measured
            `--conversation-footer-height` the transcript pads against. */}
        <div ref={footerRef} data-slot="conversation-footer" className="conversation-footer">
          {/* Sits in normal flow above the composer, so the footer measurement pads the transcript for it. */}
          {footerNotice}
          <AgentStatusPill
            status={status}
            onRetry={(tempId) => onRetrySend?.(tempId)}
            onDelete={(tempId) => onDeleteSend?.(tempId)}
          />
          {conversation?.channel ? (
            // The agent talks on the platform; the owner only watches here.
            <p data-slot="channel-readonly-note" className={cn("py-3 text-center text-sm text-fg-muted", conversationColumn)}>
              {t("chat.channelReadOnly", { platform: channelPlatformName(conversation.channel.kind) })}
            </p>
          ) : (
          <Composer
            key={prefillText ? "prefilled" : "empty"}
            initialValue={prefillText}
            agents={
              isGroup
                ? [...(participants.length > 0 ? participants : (agents ?? [])), broadcastCandidate(t("mention.allAgents"))]
                : participants.length > 0
                  ? participants
                  : (agents ?? [])
            }
            primaryAgent={primaryAgent ?? undefined}
            onUploadFile={onUploadFile}
            accent={accent !== undefined}
            requireMention={isGroup}
            placeholder={
              isGroup
                ? t("chat.placeholderGroup", { name: title })
                : t("chat.placeholder", { name: title })
            }
            running={Boolean(stoppableRun)}
            onStop={stoppableRun && onStopRun ? () => onStopRun(stoppableRun.id) : undefined}
            disabled={sending}
            reply={reply}
            onCancelReply={() => setReply(null)}
            onSend={handleComposerSend}
            onActivity={typing.reportTyping}
            onInactivity={typing.stopTyping}
            // Owner feedback 2026-10-05: the composer sits in the same centred 760px column as the
            // transcript, so the message box lines up with the messages above it.
            className={conversationColumn}
          />
          )}
        </div>
      </div>
    </div>
  );
}
