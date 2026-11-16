import type { Agent } from "@agent-desktop/client";
import { useAuthIdentity, usePeople } from "../../auth/AuthContext";
import { Message, MessageContent } from "@agent-desktop/ui";
import { CircleAlert } from "lucide-react";
import { t } from "../../lib/i18n";
import { ChannelMarker } from "../channel/platforms";
import type { UserMessageItem } from "../../lib/items";
import { splitQuote } from "../../lib/quote";
import { MentionText } from "./MentionText";
import { MessageAttachments } from "./MessageAttachments";
import { MessageMenu, QuoteCard, type ReplyTarget } from "./MessageMenu";

export interface UserMessageProps {
  item: UserMessageItem;
  agentById?: (id: string) => Agent | undefined;
  onOpenAgent?: (agentId: string) => void;
  /** The server refused this send: a small red mark sits beside the bubble (the pill offers Retry). */
  refused?: boolean;
  onReply?: (target: ReplyTarget) => void;
  /** Resends a refused message (only passed for those). */
  onRetry?: () => void;
  className?: string;
}

/**
 * The human's turn: canonical recipients appear inline, inheriting the user bubble foreground.
 * Metadata-only legacy recipients precede the text; attachments remain below the bubble.
 */
export function UserMessage({ item, agentById, onOpenAgent, refused, onReply, onRetry, className }: UserMessageProps) {
  const { isSelf, memberName } = usePeople();
  const self = isSelf(item.authorId);
  // Another member is named only when we know who is signed in; without that, every message would wrongly carry its author id.
  const signedIn = useAuthIdentity()?.mode === "account";
  const otherMember = signedIn && !self;
  // On a platform `channelSender` says who spoke; a stranger's `authorId` is a synthetic `ext-…` id (the owner's only when the owner spoke),
  // so their name comes from `channelSender`, never from the member directory.
  const stranger = item.channelSender?.role === "stranger";
  const strangerName = item.channelSender?.name || t("transcript.someone");

  const { quote, body } = splitQuote(item.text);
  const bubble = (
    <MessageMenu
      itemId={item.id}
      at={item.at}
      copyText={body}
      align={stranger ? "start" : "end"}
      reaction={item.reaction}
      onReply={onReply && (() => onReply({ name: stranger ? strangerName : self ? t("transcript.you") : memberName(item.authorId), text: body }))}
      onRetry={onRetry}
    >
      <MessageContent>
        {quote === undefined ? null : <QuoteCard text={quote} />}
        <MentionText text={body} mentions={item.mentions} agentById={agentById} onOpenAgent={onOpenAgent} />
      </MessageContent>
    </MessageMenu>
  );

  return (
    // A stranger is someone else in the room: the incoming (assistant-side) bubble, left-aligned.
    <Message from={stranger ? "assistant" : "user"} className={className}>
      {stranger ? (
        <span className="pl-0.5 text-xs font-medium text-fg-subtle">{strangerName}</span>
      ) : otherMember ? (
        <span className="pr-0.5 text-xs font-medium text-fg-subtle">{memberName(item.authorId)}</span>
      ) : null}

      {item.attachments.length > 0 ? <MessageAttachments attachments={item.attachments} align={stranger ? "start" : "end"} /> : null}

      {/* A message that is only a file shows no empty bubble. */}
      {body.trim() === "" && quote === undefined && item.attachments.length > 0 ? null : refused ? (
        <div className="flex items-center justify-end gap-1.5">
          <CircleAlert role="img" aria-label={t("agentStatus.refusedMark")} className="size-3.5 shrink-0 text-danger" />
          {bubble}
        </div>
      ) : (
        bubble
      )}

      {item.source ? <ChannelMarker kind={item.source.kind} direction="from" className={stranger ? "self-start pl-0.5" : "self-end pr-0.5"} /> : null}

    </Message>
  );
}
