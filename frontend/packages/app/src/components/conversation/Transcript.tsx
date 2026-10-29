import type { Agent, Item, Request } from "@agent-desktop/client";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  Message,
  MessageContent,
  cn,
} from "@agent-desktop/ui";
import { Fragment, useRef } from "react";
import { formatDaySeparator } from "../../lib/format";
import { t } from "../../lib/i18n";
import { feedRefsAfterReply, runsWithFeedRef } from "../../lib/items";
import { AgentMessage } from "./AgentMessage";
import type { ReplyTarget } from "./MessageMenu";
import { ArtifactItem } from "./ArtifactItem";
import { HandoffMarker } from "./HandoffMarker";
import { PlanItem } from "./PlanItem";
import { RequestItem } from "./RequestItem";
import { FeedRefItem } from "./FeedRefItem";
import { RoleSuggestionItem } from "./RoleSuggestionItem";
import { RoutineItem } from "./RoutineItem";
import { RunItem } from "./RunItem";
import { SystemRow } from "./SystemRow";
import { ChildRuns } from "../run/ChildRuns";
import { UserMessage } from "./UserMessage";

export interface TranscriptProps {
  items: Item[];
  /**
   * Shows the small awaiting-reply bubble after the last item. The caller owns the
   * semantics (post-send window only — never tool/wait states); this only renders it.
   */
  showAwaiting?: boolean;
  /** The run behind the awaiting bubble; with `onOpenRun`, tapping the bubble opens its Activity. */
  awaitingRunId?: string;
  /** Resolves an agent by id (agents may repeat, so a lookup beats a prop per item). */
  agentById?: (id: string) => Agent | undefined;
  /** Every known agent; agent prose @handles resolve against this complete roster. */
  agents?: Agent[];
  /** Opens the agent for a mention Message action; absent hides the button. */
  onOpenAgent?: (agentId: string) => void;
  /** Group chats show the speaking agent's name and avatar on each message. */
  showAuthors?: boolean;
  emptyName?: string;
  /** Name used in hand-off dividers ("You handed control back to …"). */
  primaryAgentName?: string;
  onOpenRun?: (runId: string) => void;
  onStopRun?: (runId: string) => void;
  onOpenSignin?: (request: Request) => void;
  onOpenRoutine?: (routineId: string) => void;
  onOpenCitation?: (url: string) => void;
  onSystemAction?: (command: string) => void;
  /** Refused messages (placeholder id to reason): each gets a red mark beside its bubble. Retry and Delete live in the agent-status pill. */
  refused?: Readonly<Record<string, string>>;
  /** Reply action of a message bubble; absent hides Reply. */
  onReply?: (target: ReplyTarget) => void;
  /** Resend a refused message (its placeholder id). */
  onRetrySend?: (tempId: string) => void;
  /** Sends a reply-option button as the user's message. */
  onPickReply?: (text: string) => void;
  className?: string;
}

/**
 * The one centred message column, shared with the composer sibling in `ConversationView` so the
 * message edges and the input pill line up on the same 760px axis (owner feedback 2026-10-05).
 * Authorship (left/right bubble edges) is decided inside the message components.
 */
export const conversationColumn = "mx-auto w-full max-w-[760px]";

/**
 * The conversation body: renders every `Item` variant through one registry (ARCHITECTURE §4.3)
 * on top of the ui AI Elements `Conversation` (`use-stick-to-bottom`), which opens a thread at
 * its latest message and keeps the reader pinned there while items stream in — unless they
 * scrolled up, in which case the "jump to latest" pill floats above the composer.
 */
export function Transcript({
  items,
  showAwaiting,
  awaitingRunId,
  agentById,
  agents,
  onOpenAgent,
  showAuthors,
  emptyName = "your agent",
  primaryAgentName,
  onOpenRun,
  onStopRun,
  onOpenSignin,
  onOpenRoutine,
  onOpenCitation,
  onSystemAction,
  refused,
  onReply,
  onRetrySend,
  onPickReply,
  className,
}: TranscriptProps) {
  /**
   * Entrance motion (UF6): only items newer than this mount animate in — a cached
   * conversation remounting never replays history. Keyed by the first item so empty
   * and non-empty conversations each start their own session.
   */
  const sessionRef = useRef<string | null>(null);
  const sessionStartRef = useRef(0);
  const firstId = items.length > 0 && items[0] ? items[0].id : null;
  if (sessionRef.current !== firstId) {
    sessionRef.current = firstId;
    sessionStartRef.current = Date.now();
  }
  const isFresh = (at: string) => {
    const time = Date.parse(at);
    return !Number.isNaN(time) && time > sessionStartRef.current;
  };
  const ordered = feedRefsAfterReply(items);
  const postedRuns = runsWithFeedRef(items);

  // Consecutive messages of one agent reply read as a group, like several texts in a row: the author
  // shows once, and the gap inside the group is tighter.
  const continuesGroup = (item: Item, previous: Item | undefined) =>
    item.type === "agent_message" &&
    previous?.type === "agent_message" &&
    item.runId !== undefined &&
    item.runId === previous.runId &&
    item.agentId === previous.agentId;

  // Reply buttons live on the latest agent turn only: once the user has written after a bubble they go.
  const lastUserAt = items.map((entry) => entry.type).lastIndexOf("user_message");
  const renderItem = (item: Item, grouped: boolean) => {
    switch (item.type) {
      case "user_message":
        return (
          <UserMessage
            key={item.id}
            item={item}
            agentById={agentById}
            onOpenAgent={onOpenAgent}
            refused={refused?.[item.id] !== undefined}
            onReply={onReply}
            onRetry={refused?.[item.id] !== undefined && onRetrySend ? () => onRetrySend(item.id) : undefined}
          />
        );
      case "agent_message":
        return (
          <AgentMessage
            key={item.id}
            item={item}
            agent={agentById?.(item.agentId)}
            agents={agents}
            showAuthor={showAuthors && !grouped}
            onOpenAgent={onOpenAgent}
            onOpenCitation={onOpenCitation}
            onReply={onReply}
            onPickReply={items.indexOf(item) > lastUserAt ? onPickReply : undefined}
            hideCitations={item.runId !== undefined && postedRuns.has(item.runId)}
          />
        );
      case "run":
        return (
          <Fragment key={item.id}>
            <RunItem item={item} onOpenThread={onOpenRun} />
            <ChildRuns parentRunId={item.runId} conversationId={item.conversationId} agentById={agentById} onOpenRun={onOpenRun} onStopRun={onStopRun} />
          </Fragment>
        );

      case "plan":
        return <PlanItem key={item.id} item={item} />;
      case "request":
        return <RequestItem key={item.id} item={item} onOpenSignin={onOpenSignin} />;
      case "artifact":
        return <ArtifactItem key={item.id} item={item} />;
      case "routine":
        return <RoutineItem key={item.id} item={item} onOpen={onOpenRoutine} />;
      case "feed_ref":
        return <FeedRefItem key={item.id} item={item} />;
      case "role_suggestion":
        return <RoleSuggestionItem key={item.id} item={item} />;
      case "handoff":
        return <HandoffMarker key={item.id} item={item} agentName={primaryAgentName} />;
      case "system":
        return <SystemRow key={item.id} item={item} onAction={onSystemAction} />;
      default:
        return null;
    }
  };

  return (
    <div data-slot="transcript" className="flex min-h-0 flex-1 flex-col">
      {/* Owner feedback 2026-10-05: layout changes (opening the computer pane) must not animate
          the whole history. `instant` keeps the reader anchored at this end of the thread and
          reserves smooth scrolling for new messages, not for a resize. */}
      <Conversation className={className} initial="instant" resize="instant">
        {/* `transcript-content` (UI92) pads the last row clear of the real footer height
            plus the 64px fade via `--conversation-footer-height`; `pb-16` is the 64px
            fallback before the footer has been measured. */}
        <ConversationContent
          scrollClassName="transcript-scroller"
          className={cn(conversationColumn, "transcript-content gap-1.5 px-4 pt-4 pb-16")}
        >
          {items.length === 0 ? (
            showAwaiting ? null : (
              <div className="px-4 py-16 text-center">
                <p className="text-sm font-medium text-fg">{t("transcript.empty")}</p>
                <p className="mt-1 text-sm text-fg-muted">
                  {t("transcript.emptyHint", { name: emptyName })}
                </p>
              </div>
            )
          ) : (
            ordered.map((item, index) => {
              const day = new Date(item.at).toDateString();
              const previous = ordered[index - 1];
              const newDay = index === 0 || day !== new Date(previous?.at ?? item.at).toDateString();
              const grouped = continuesGroup(item, ordered[index - 1]);
              return (
                <Fragment key={item.id}>
                  {newDay && !Number.isNaN(Date.parse(item.at)) ? (
                    <div role="separator" className="my-1 flex justify-center">
                      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-fg-muted">
                        {formatDaySeparator(item.at, { today: t("transcript.today"), yesterday: t("transcript.yesterday") })}
                      </span>
                    </div>
                  ) : null}
                  <div className={cn(isFresh(item.at) && "transcript-enter", grouped && "-mt-1")}>{renderItem(item, grouped)}</div>
                </Fragment>
              );
            })
          )}
          {/* Awaiting-reply bubble: agent-bubble language, mounted only in the post-send
              window and replaced atomically by the first assistant text (same commit flips
              both), so no vertical flash. Never a typewriter — chunks do not exist. */}
          {showAwaiting ? (
            <div data-testid="transcript-awaiting" className="flex justify-start">
              <Message from="assistant">
                <MessageContent aria-label={awaitingRunId && onOpenRun ? undefined : t("transcript.waitingReply")}>
                  {awaitingRunId && onOpenRun ? (
                    <button
                      type="button"
                      data-slot="typing-open"
                      aria-label={t("transcript.openActivity")}
                      onClick={() => onOpenRun(awaitingRunId)}
                      className="cursor-pointer rounded-full focus-ring"
                    >
                      <TypingDots />
                    </button>
                  ) : (
                    <TypingDots />
                  )}
                </MessageContent>
              </Message>
            </div>
          ) : null}
        </ConversationContent>
        {/* Floating pill above the fade overlay, shown only while scrolled up. */}
        <ConversationScrollButton
          aria-label={t("transcript.jumpToLatest")}
          title={t("transcript.jumpToLatest")}
          className={cn(
            "transcript-jump z-10 size-8 rounded-full border-border-subtle bg-bg-subtle text-fg shadow-overlay",
            "hover:bg-bg-subtle dark:border-border-subtle dark:bg-bg-subtle dark:hover:bg-bg-subtle",
          )}
        />
      </Conversation>
    </div>
  );
}

function TypingDots() {
  return (
    <span aria-hidden className="typing-dots">
      <span />
      <span />
      <span />
    </span>
  );
}
