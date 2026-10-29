import type { Agent, MemoryItemView, MemoryTopicView, UpdateMemoryItemInput } from "@agent-desktop/client";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  ErrorState,
  FormField,
  Label,
  LoadingState,
  SearchField,
  SegmentedControl,
  Switch,
  Textarea,
  toast,
} from "@agent-desktop/ui";
import { ChevronRight, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { AgentAvatar } from "../../components/agent/AgentAvatar";
import { useAgents } from "../../data/queries";
import { t } from "../../lib/i18n";
import {
  isMemoryUnavailable,
  isUnavailable,
  useDeleteMemoryItem,
  useMemoryItems,
  useMemoryReview,
  useMemoryTopics,
  useResolveMemoryReview,
  useUpdateMemoryItem,
} from "../../data/people";
import { TeamComingSoon } from "./TeamComingSoon";

const onError = () => toast.error(t("common.error"));

/** The route's ids for Memory's two sub-screens (`/team/memory/review`, `/team/memory/search`). */
export const REVIEW_ID = "review";
export const SEARCH_ID = "search";

/** Who may hear an item: `keep` is the group it was said in (only offered when it has one), `owner` or `public`. */
type Audience = "keep" | "owner" | "public";

/** What the server calls the place of an item no conversation is known for. */
const EARLIER_MEMORY = "Earlier memory";

/** The order the topics come in (the server's order has people before agents). */
const TOPIC_ORDER: readonly string[] = ["identity", "health", "work", "plans", "preferences", "agents", "people", "home", "other"];

/** Agents shown in the header and beside a topic's label. */
const AVATAR_LIMIT = 3;

/** "<where it was said> · <who may hear it>", both as the server words them. */
function metaLine(item: MemoryItemView): string {
  return [item.saidIn.label, item.audience.label].filter(Boolean).join(" · ");
}

/** An item's text as a sentence of its own (the fallback prose of a topic that has no summary yet). */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?。！？]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** "today", "yesterday" or a short date: when the nightly job last tidied the memory. */
function tidiedWhen(iso: string, now: Date = new Date()): string {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((day(now) - day(new Date(iso))) / 86_400_000);
  if (diff <= 0) return t("team.memoryTidiedToday");
  if (diff === 1) return t("team.memoryTidiedYesterday");
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function AvatarStack({ agents, size }: { agents: readonly Agent[]; size: number }) {
  if (agents.length === 0) return null;
  return (
    <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
      {agents.slice(0, AVATAR_LIMIT).map((agent) => (
        <AgentAvatar key={agent.id} agentId={agent.id} avatar={agent.avatar} size={size} />
      ))}
    </span>
  );
}

/** Under the page title: the agents' small avatars and "From your chats · tidied tonight". */
export function MemoryHeaderLine() {
  const { data: agents } = useAgents();
  const topics = useMemoryTopics(true);
  const latest = (topics.data?.items ?? []).map((topic) => topic.updatedAt).sort().at(-1);
  return (
    <span className="flex items-center gap-2">
      <AvatarStack agents={agents ?? []} size={22} />
      <span className="truncate">{latest ? t("team.memoryFrom", { when: tidiedWhen(latest) }) : t("team.memoryFrom", { when: t("team.memoryTidiedToday") })}</span>
    </span>
  );
}

/**
 * Memory (Team; prose view, owner-approved 2026-10-26 "No boxes"): what the agents remember, written as a few paragraphs.
 * Under the page header (the title, who wrote it, when it was tidied) comes the "N things to check" line while items wait,
 * then one paragraph per topic: its small caps label with the avatars of the agents that wrote items in it, and the summary
 * the nightly job wrote. A phrase that states one memory item is dotted-underlined, and a tap on it opens that item's sheet
 * (the fact as an editable field, who said it, who can hear it, Keep private, Forget). Search is an icon in the top bar (`/team/memory/search`),
 * the review queue its own screen (`/team/memory/review`). Each change shows at once and is put back if the server refuses it.
 * 404 shows "Coming soon"; 503 says memory is unavailable right now, quietly.
 */
export function MemorySegment({ detailId }: { detailId?: string | undefined }) {
  const items = useMemoryItems(true);
  const topics = useMemoryTopics(true);
  const review = useMemoryReview(items.isSuccess);
  const failed = items.error ?? topics.error;
  if (isUnavailable(failed)) return <TeamComingSoon />;
  if (isMemoryUnavailable(failed)) return <p className="px-1 text-sm text-fg-muted">{t("team.memoryUnavailable")}</p>;
  if (items.isLoading || topics.isLoading) return <LoadingState label={t("common.loading")} />;
  if (items.isError || topics.isError) {
    return <ErrorState title={t("common.error")} onRetry={() => void Promise.all([items.refetch(), topics.refetch()])} />;
  }

  const loaded = items.data?.pages.flatMap((page) => page.items) ?? [];
  const waiting = review.data?.items ?? [];
  const cards = [...(topics.data?.items ?? [])].sort((a, b) => TOPIC_ORDER.indexOf(a.topic) - TOPIC_ORDER.indexOf(b.topic));
  if (detailId === REVIEW_ID) return <ReviewList waiting={waiting} />;
  if (detailId === SEARCH_ID) {
    return <MemorySearch loaded={loaded} hasNextPage={items.hasNextPage} fetchingNextPage={items.isFetchingNextPage} fetchNextPage={() => void items.fetchNextPage()} />;
  }
  return (
    <>
      {waiting.length > 0 ? <ReviewLine count={waiting.length} /> : null}
      {cards.length === 0 && loaded.length === 0 ? <EmptyState title={t("team.memoryEmpty")} /> : null}
      <div className="flex flex-col gap-7 pt-1">
        {cards.map((card) => (
          <TopicSection key={card.topic} card={card} />
        ))}
      </div>
    </>
  );
}

/** "2 things to check ›" with an orange dot; opens the review queue. */
function ReviewLine({ count }: { count: number }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`/team/memory/${REVIEW_ID}`)} className="flex items-center gap-2 self-start py-1.5 text-[15px] text-fg focus-ring">
      <span aria-hidden="true" className="size-[7px] rounded-full bg-warning" />
      {t(count === 1 ? "team.reviewThingOne" : "team.reviewThings", { count })}
      <ChevronRight className="size-3 text-fg-subtle" />
    </button>
  );
}

/**
 * One topic: the small caps label (with the avatars of the agents that wrote its items), then the summary as prose. The
 * topic's own items are loaded so a phrase can open its item; while the summary is empty the items' texts stand in for it.
 */
function TopicSection({ card }: { card: MemoryTopicView }) {
  const { data: agents } = useAgents();
  const list = useMemoryItems(true, card.topic);
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const item = items.find((candidate) => candidate.id === openId);

  // A phrase may name an item beyond the first page of the topic: keep loading until every named item is there.
  const missing = card.segments.some((segment) => segment.itemId !== undefined && !items.some((candidate) => candidate.id === segment.itemId));
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  useEffect(() => {
    if (missing && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [missing, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const writers = (agents ?? []).filter((agent) => items.some((candidate) => candidate.agentId === agent.id));
  const pieces: Array<{ text: string; itemId?: string | undefined }> = card.summary.trim()
    ? card.segments.length > 0
      ? card.segments
      : [{ text: card.summary }]
    : items.flatMap((candidate, index) => [...(index > 0 ? [{ text: " " }] : []), { text: sentence(candidate.text), itemId: candidate.id }]);

  return (
    <section aria-label={card.label} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-fg-subtle">{card.label}</h2>
        {writers.length > 0 ? (
          <span title={writers.map((agent) => t("team.memoryUsedBy", { name: agent.name })).join(", ")}>
            <AvatarStack agents={writers} size={20} />
          </span>
        ) : null}
      </div>
      <p className="text-[21px] leading-[1.45] tracking-[-0.01em] text-fg">
        {pieces.map((piece, index) =>
          piece.itemId ? (
            <button
              key={index}
              type="button"
              onClick={() => setOpenId(piece.itemId)}
              className="inline cursor-pointer text-left underline decoration-fg/35 decoration-dotted underline-offset-[5px] hover:decoration-fg/60 focus-ring"
            >
              {piece.text}
            </button>
          ) : (
            <span key={index}>{piece.text}</span>
          ),
        )}
      </p>
      <FactSheet item={item} onClose={() => setOpenId(undefined)} />
    </section>
  );
}

/** Search (the top bar's icon): the matching items of everything loaded, as plain lines; a tap opens the item's sheet. */
function MemorySearch({
  loaded,
  hasNextPage,
  fetchingNextPage,
  fetchNextPage,
}: {
  loaded: MemoryItemView[];
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const { data: agents } = useAgents();
  const text = query.trim().toLowerCase();
  const found = text ? loaded.filter((item) => item.text.toLowerCase().includes(text)) : [];
  return (
    <>
      <SearchField value={query} onValueChange={setQuery} placeholder={t("team.memorySearch")} />
      {text && found.length === 0 ? <p className="px-1 text-sm text-fg-muted">{t("team.memoryNoMatch")}</p> : null}
      {found.length > 0 ? (
        <ul aria-label={t("team.memory")} className="flex flex-col divide-y divide-border/60">
          {found.map((item) => {
            const agent = item.agentId ? agents?.find((candidate) => candidate.id === item.agentId) : undefined;
            const group = item.audience.kind === "group" ? item.audience.label : "";
            return (
              <li key={item.id}>
                <button type="button" onClick={() => setOpenId(item.id)} className="flex w-full items-start gap-3 rounded-xl px-1 py-3 text-left hover:bg-interactive-hover focus-ring">
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 block text-sm text-fg">{item.text}</span>
                    {item.sensitive || group ? (
                      <span className="mt-1 flex items-center gap-1.5 text-[13px] text-fg-muted">
                        {item.sensitive ? <Lock className="size-3 shrink-0" aria-label={t("team.sensitive")} /> : null}
                        {group ? <span className="truncate">{group}</span> : null}
                      </span>
                    ) : null}
                  </span>
                  {agent ? <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={20} className="mt-0.5 shrink-0" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {hasNextPage && text ? (
        <Button variant="ghost" size="sm" className="self-center rounded-full" disabled={fetchingNextPage} onClick={fetchNextPage}>
          {t("common.showMore")}
        </Button>
      ) : null}
      <FactSheet item={loaded.find((item) => item.id === openId)} onClose={() => setOpenId(undefined)} />
    </>
  );
}

/** The dialog of one fact; closed while `item` is undefined (also once the item has been forgotten). */
function FactSheet({ item, onClose }: { item: MemoryItemView | undefined; onClose: () => void }) {
  return item ? <FactDialog key={item.id} item={item} onClose={onClose} /> : null;
}

/**
 * One fact, in the app's dialog format (title "Memory", close top right, Cancel and Save in the footer, Forget as the
 * destructive action): the text as an editable field (Save sends only the text, and only once it changed), the person's own
 * words (`quote`, in curly quotes, with "where · date of the quote" under it; without one the line "Said by … · where · date"
 * stands in) with the writing agent's avatar, who may hear it and the Keep private switch (= sensitive; both apply at once) and
 * Forget (after a confirm).
 */
function FactDialog({ item, onClose }: { item: MemoryItemView; onClose: () => void }) {
  const { data: agents } = useAgents();
  const update = useUpdateMemoryItem();
  const remove = useDeleteMemoryItem();
  const [draft, setDraft] = useState(item.text);
  const [forgetting, setForgetting] = useState(false);
  const agent = item.agentId ? agents?.find((candidate) => candidate.id === item.agentId) : undefined;

  const trimmed = draft.trim();
  const changed = trimmed !== "" && trimmed !== item.text;
  const audience: Audience = item.audience.kind === "group" ? "keep" : item.audience.kind === "public" ? "public" : "owner";
  const pills: { value: Audience; label: string }[] = [
    { value: "owner", label: t("team.audienceOwner") },
    ...(item.audience.kind === "group" ? [{ value: "keep" as const, label: item.audience.label }] : []),
    { value: "public", label: t("team.audiencePublic") },
  ];
  const date = new Date(item.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  // "Said by you · Your chat · 26 Oct 2026"; "Earlier memory" (an item the nightly tidy took over) says nothing about where.
  const where = item.saidIn.label === EARLIER_MEMORY ? undefined : item.saidIn.label;
  // The person being helped reads as "you", whatever name their own person carries (it can still be the "Owner" fallback).
  const who = item.saidBy ? (item.saidBy.kind === "owner" ? t("team.memorySaidByYou") : t("team.memorySaidBy", { name: item.saidBy.name })) : undefined;
  const source = item.quote
    ? [where, new Date(item.quote.at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })].filter(Boolean).join(" · ")
    : [who, where, date].filter(Boolean).join(" · ");

  const save = () => {
    if (!changed) return;
    const patch: UpdateMemoryItemInput = { text: trimmed };
    update.mutate({ id: item.id, patch }, { onError });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("team.memory")}</DialogTitle>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4 p-0.5"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <FormField label={t("team.memoryText")}>
            <Textarea value={draft} maxLength={1000} rows={4} onChange={(event) => setDraft(event.currentTarget.value)} />
          </FormField>
          <div className="flex flex-col gap-1.5">
            {item.quote ? <blockquote className="text-[15px] leading-snug text-fg">{`“${item.quote.text}”`}</blockquote> : null}
            <p className="flex items-center gap-2 text-xs text-fg-subtle">
              {agent ? <AgentAvatar agentId={agent.id} avatar={agent.avatar} size={20} className="shrink-0" /> : null}
              <span className="min-w-0">{source}</span>
            </p>
          </div>

          <FormField label={t("team.audience")} raw>
            <SegmentedControl
              fill
              aria-label={t("team.audience")}
              value={audience}
              onValueChange={(next) => {
                if (next === "keep" || next === audience) return;
                update.mutate({ id: item.id, patch: { audience: next === "public" ? "public" : "owner" } }, { onError });
              }}
              items={pills}
            />
          </FormField>

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor="memory-keep-private">{t("team.keepPrivate")}</Label>
              <p className="text-xs text-fg-subtle">{t("team.sensitiveHint")}</p>
            </div>
            <Switch
              id="memory-keep-private"
              checked={item.sensitive}
              onCheckedChange={(sensitive) => update.mutate({ id: item.id, patch: { sensitive } }, { onError })}
            />
          </div>

          <DialogFooter className="flex-wrap sm:justify-between">
            <Button type="button" variant="destructive" onClick={() => setForgetting(true)}>
              {t("team.memoryForget")}
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={onClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={!changed}>
                {t("common.save")}
              </Button>
            </div>
          </DialogFooter>
        </form>
        <ConfirmForget
          open={forgetting}
          onOpenChange={setForgetting}
          onConfirm={() => {
            remove.mutate(item.id, { onError });
            onClose();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The review queue: Keep an item (it stays remembered) or Delete it (asks first). */
function ReviewList({ waiting }: { waiting: MemoryItemView[] }) {
  if (waiting.length === 0) return <EmptyState title={t("team.reviewEmpty")} />;
  return (
    <section aria-label={t("team.memoryReview")} className="flex flex-col gap-2">
      {waiting.map((item) => (
        <ReviewRow key={item.id} item={item} />
      ))}
    </section>
  );
}

function ReviewRow({ item }: { item: MemoryItemView }) {
  const resolve = useResolveMemoryReview();
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 rounded-2xl bg-muted/70 p-3">
      <p className="line-clamp-3 text-sm text-fg">{item.text}</p>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-muted">{metaLine(item)}</span>
        <Button
          variant="ghost"
          size="xs"
          className="rounded-full"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ id: item.id, input: { action: "keep" } }, { onError })}
        >
          {t("team.memoryKeep")}
        </Button>
        <Button variant="ghost" size="xs" className="rounded-full" disabled={resolve.isPending} onClick={() => setDeleting(true)}>
          {t("common.delete")}
        </Button>
      </div>
      <ConfirmForget open={deleting} onOpenChange={setDeleting} onConfirm={() => resolve.mutate({ id: item.id, input: { action: "delete" } }, { onError })} />
    </div>
  );
}

/** The "are you sure" for forgetting something for good. */
function ConfirmForget({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("team.forgetTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("team.forgetBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t("team.memoryForget")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
