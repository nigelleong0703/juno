import type { Agent } from "@agent-desktop/client";
import { Message, MessageContent, MessageResponse, Popover, PopoverContent, PopoverTrigger } from "@agent-desktop/ui";
import { ExternalLink, Link2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { AgentMessageItem } from "../../lib/items";
import { t } from "../../lib/i18n";
import { AgentAvatar } from "../agent/AgentAvatar";
import { ChannelMarker } from "../channel/platforms";
import { splitQuote } from "../../lib/quote";
import { MessageMenu, QuoteCard, type ReplyTarget } from "./MessageMenu";
import { UiDoc } from "../uidoc/UiDoc";
import {
  agentMentionAllowedTags,
  agentMentionComponents,
  agentMentionRemarkPlugins,
  buildAgentMentionRoster,
} from "./agentMention";

export interface AgentMessageProps {
  item: AgentMessageItem;
  agent?: Agent;
  /** Every known agent; a @handle in the prose resolves when it names exactly one of them. */
  agents?: Agent[];
  /** Group chats show who is speaking above each bubble (修订 v0.3). */
  showAuthor?: boolean;
  /** Opens an agent's canonical direct chat; carries the canonical agent id. */
  onOpenAgent?: (agentId: string) => void;
  onOpenCitation?: (url: string) => void;
  onReply?: (target: ReplyTarget) => void;
  /** The run posted to the Feed: its sources live on the post. */
  hideCitations?: boolean;
  /** Sends a reply option as the user's message; given only on the latest agent turn, so the buttons hide afterwards. */
  onPickReply?: (text: string) => void;
  className?: string;
}

const hostOf = (url?: string) => {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
};

function Favicon({ url, size }: { url?: string; size: number }) {
  const [broken, setBroken] = useState(false);
  const host = hostOf(url);
  return host && !broken ? (
    <img src={`https://www.google.com/s2/favicons?domain=${host}&sz=64`} alt="" width={size} height={size} onError={() => setBroken(true)} className="shrink-0 rounded-full bg-bg object-cover" style={{ width: size, height: size }} />
  ) : (
    <span className="grid shrink-0 place-items-center rounded-full bg-bg-subtle text-fg-subtle" style={{ width: size, height: size }}>
      <Link2 className="size-2.5" />
    </span>
  );
}

type SourceCitation = AgentMessageItem["citations"][number] & { url: string };

/** Only citations that link somewhere are sources: a memory citation has no page to open, so it never earns the chip. */
const linkedSources = (citations: AgentMessageItem["citations"]): SourceCitation[] =>
  citations.filter((citation): citation is SourceCitation => Boolean(citation.url));

/** "Sources" under a reply: up to three overlapping site icons; a popover lists every source. */
function SourcesPill({ citations, onOpen }: { citations: SourceCitation[]; onOpen?: (url: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t("message.sources", { count: citations.length })} className="mt-1 inline-flex h-6 items-center gap-1.5 rounded-full focus-ring">
          <span className="flex -space-x-1.5">
            {citations.slice(0, 3).map((citation) => (
              <span key={citation.id} className="rounded-full ring-2 ring-bg-subtle">
                <Favicon url={citation.url} size={16} />
              </span>
            ))}
          </span>
          <span className="text-xs text-fg-subtle">{t("message.sourcesLabel")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-1.5">
        <ul className="flex max-h-72 flex-col overflow-y-auto">
          {citations.map((citation) => (
            <li key={citation.id}>
              <button
                type="button"
                onClick={() => onOpen?.(citation.url)}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left focus-ring hover:bg-bg-subtle"
              >
                <Favicon url={citation.url} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block text-sm font-medium text-fg">{citation.title}</span>
                  <span className="block truncate text-xs text-fg-muted">{hostOf(citation.url)}</span>
                </span>
                <ExternalLink className="size-3.5 shrink-0 text-fg-subtle" />
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The agent's turn (VISUAL.md "Messages"): a grey bubble on the left, markdown body through
 * Streamdown, source citations and a copy affordance.
 */
export function AgentMessage({
  item,
  agent,
  agents,
  showAuthor,
  onOpenAgent,
  onOpenCitation,
  onReply,
  hideCitations,
  onPickReply,
  className,
}: AgentMessageProps) {
  // A @handle resolves against the complete known roster, never a guess. The components carry
  // the roster by closure, so the streamed Markdown re-presents when the roster loads or an
  // agent is renamed: `MessageResponse`'s memo only compares children/isAnimating, so the
  // roster revision is the stable remount key that lets a changed presentation through.
  const roster = useMemo(() => buildAgentMentionRoster(agents), [agents]);
  const openAgentRef = useRef(onOpenAgent);
  openAgentRef.current = onOpenAgent;
  const mentionComponents = useMemo(
    () => agentMentionComponents(roster, (agentId) => openAgentRef.current?.(agentId)),
    [roster],
  );
  const mentionPlugins = useMemo(() => agentMentionRemarkPlugins(roster), [roster]);

  // `markdown` is the lead-in, or the card's own text fallback when the agent gave no lead-in: then only the card shows.
  const { quote, body } = splitQuote(item.markdown);
  const sources = linkedSources(item.citations);
  const replies = onPickReply ? item.ui?.blocks.find((block) => block.type === "replies") : undefined;
  const showCard = item.ui?.blocks.some((block) => block.type !== "replies");
  const showBubble = !item.ui || (item.markdown.trim() !== "" && item.markdown.trim() !== item.ui.text?.trim());

  return (
    <Message from="assistant" className={className}>
      {showAuthor && (
        <button
          type="button"
          disabled={!agent || !onOpenAgent}
          onClick={() => agent && onOpenAgent?.(agent.id)}
          className="flex w-fit items-center gap-1.5 rounded-full pl-0.5 pr-1.5 enabled:cursor-pointer focus-ring"
        >
          {agent ? (
            <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={18} flat />
          ) : (
            <span className="size-[18px] shrink-0 rounded-full bg-bg-subtle" />
          )}
          <span className="text-xs font-medium text-fg-muted">{agent?.name ?? "Agent"}</span>
        </button>
      )}

      {showBubble ? (
        <MessageMenu
          itemId={item.id}
          copyText={item.markdown}
          align="start"
          onReply={onReply && (() => onReply({ name: agent?.name ?? "Agent", text: body }))}
        >
          <MessageContent>
            {quote === undefined ? null : <QuoteCard text={quote} />}
            <MessageResponse
              key={roster.revision}
              allowedTags={agentMentionAllowedTags}
              components={mentionComponents}
              remarkPlugins={mentionPlugins}
            >
              {body}
            </MessageResponse>

            {!hideCitations && sources.length > 0 && <SourcesPill citations={sources} onOpen={onOpenCitation} />}
          </MessageContent>
        </MessageMenu>
      ) : null}
      {item.replyTo ? <ChannelMarker kind={item.replyTo.kind} direction="to" className="pl-0.5" /> : null}
      {item.ui && showCard ? (
        <div className="max-w-[560px]">
          <UiDoc doc={item.ui} showTitle />
        </div>
      ) : null}
      {replies?.type === "replies" ? (
        <div className="flex flex-col gap-2">
          {replies.options.slice(0, 3).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onPickReply?.(option)}
              className="w-full rounded-[20px] border border-dashed border-border px-4 py-3 text-left text-sm leading-5 text-fg focus-ring hover:bg-bg-subtle"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </Message>
  );
}
