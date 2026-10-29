import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@agent-desktop/ui";
import { Check, Copy, Reply, RotateCcw, Smile } from "lucide-react";
import { useState, type ReactNode } from "react";
import { t } from "../../lib/i18n";
import { REACTIONS, useReactions } from "../../lib/reactions";

/** Who and what a reply answers: the composer chip shows it and the sent message quotes it. */
export interface ReplyTarget {
  name: string;
  text: string;
}

export interface MessageMenuProps {
  itemId: string;
  /** Text Copy puts on the clipboard. */
  copyText: string;
  /** Right-aligned (the user's own bubble) or left-aligned (an agent's). */
  align: "start" | "end";
  /** The agent's emoji on the message (`reaction` of a user message); my own reaction wins. */
  reaction?: string;
  onReply?: () => void;
  /** Present only where the message can be resent (a refused send). */
  onRetry?: () => void;
  children: ReactNode;
}

const barButton =
  "grid size-7 place-items-center rounded-full text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg focus-ring";

/**
 * What the iPhone long-press lift menu does, for a pointer: a hover action bar on the bubble's
 * corner and the same actions in a right-click menu (React, Reply, Copy, Retry). The reaction
 * is kept on this device and shown as a badge on the bubble's bottom corner; clicking it removes it.
 */
export function MessageMenu({ itemId, copyText, align, reaction, onReply, onRetry, children }: MessageMenuProps) {
  const mine = useReactions((state) => state.byItem[itemId]);
  const shown = mine ?? reaction;
  const toggle = useReactions((state) => state.toggle);
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState(false);
  const end = align === "end";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  const react = (emoji: string) => {
    toggle(itemId, emoji);
    setPicking(false);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={cn("group/msg relative w-fit max-w-full", end && "ml-auto", shown && "mb-3")}>
          {children}
          {shown ? (
            <button
              type="button"
              aria-label={mine ? t("message.removeReaction", { emoji: mine }) : shown}
              onClick={() => mine && toggle(itemId, mine)}
              className={cn(
                "absolute -bottom-3 grid h-6 min-w-6 place-items-center rounded-full border border-border bg-bg px-1 text-sm leading-none shadow-sm focus-ring",
                end ? "left-2" : "right-2",
              )}
            >
              {shown}
            </button>
          ) : null}
          <div
            className={cn(
              "absolute -top-3 z-10 flex items-center rounded-full border border-border bg-bg p-0.5 opacity-0 shadow-sm transition-opacity",
              "group-hover/msg:opacity-100 focus-within:opacity-100",
              picking && "opacity-100",
              end ? "right-2" : "left-2",
            )}
          >
            <Popover open={picking} onOpenChange={setPicking}>
              <PopoverTrigger asChild>
                <button type="button" aria-label={t("message.react")} title={t("message.react")} className={barButton}>
                  <Smile className="size-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent align={end ? "end" : "start"} className="flex w-auto gap-0.5 rounded-full p-1">
                {REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={emoji}
                    onClick={() => react(emoji)}
                    className={cn("grid size-8 place-items-center rounded-full text-lg focus-ring hover:bg-bg-subtle", mine === emoji && "bg-muted")}
                  >
                    {emoji}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            {onReply ? (
              <button type="button" aria-label={t("message.reply")} title={t("message.reply")} onClick={onReply} className={barButton}>
                <Reply className="size-3.5" />
              </button>
            ) : null}
            <button type="button" aria-label={t("message.copy")} title={t("message.copy")} onClick={() => void copy()} className={barButton}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
            {onRetry ? (
              <button type="button" aria-label={t("message.retry")} title={t("message.retry")} onClick={onRetry} className={barButton}>
                <RotateCcw className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <div className="flex justify-between px-1 py-0.5">
          {REACTIONS.map((emoji) => (
            <ContextMenuItem
              key={emoji}
              aria-label={emoji}
              onSelect={() => toggle(itemId, emoji)}
              className={cn("size-7 justify-center p-0 text-base", mine === emoji && "bg-muted")}
            >
              {emoji}
            </ContextMenuItem>
          ))}
        </div>
        <ContextMenuSeparator />
        {onReply ? (
          <ContextMenuItem onSelect={onReply}>
            <Reply className="size-4" />
            {t("message.reply")}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={() => void copy()}>
          <Copy className="size-4" />
          {t("message.copy")}
        </ContextMenuItem>
        {onRetry ? (
          <ContextMenuItem onSelect={onRetry}>
            <RotateCcw className="size-4" />
            {t("message.retry")}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A reply's quoted text inside a bubble: accent bar, muted text, two lines (iPhone `QuoteCard`). */
export function QuoteCard({ text }: { text: string }) {
  return (
    <div className="flex gap-2 rounded-lg bg-current/10 px-2 py-1.5">
      <span aria-hidden className="w-[3px] shrink-0 rounded-full bg-current opacity-55" />
      <p className="line-clamp-2 min-w-0 whitespace-pre-line text-sm opacity-75">{text}</p>
    </div>
  );
}
