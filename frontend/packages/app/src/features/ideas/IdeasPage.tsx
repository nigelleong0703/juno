import type { Agent, Idea } from "@agent-desktop/client";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  ScrollArea,
  SplitView,
  cn,
  toast,
} from "@agent-desktop/ui";
import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { AgentScopeButton } from "../../components/agent/AgentScopeButton";
import { CARD_SURFACE, DETAIL_COLUMN, PageFrame, SECTION_LABEL, SPLIT_NO_DIVIDER } from "../../components/page/PageFrame";
import { useHomeFile } from "../../data/home";
import { useAcceptIdea, useDeleteProactiveRule, useIdeaFeedback } from "../../data/mutations";
import { useAgents, useOpenIdeas } from "../../data/queries";
import { useToday } from "../../data/today";
import { ShowMore, useCapped } from "../agents/card/parts";
import { CARD_GRID, InspirationCards } from "../today/Inspiration";
import { SuggestionCard } from "./SuggestionCard";
import { cardLabel, t } from "../../lib/i18n";
import { useWideLayout } from "../../lib/useSplitSelection";

/** Cards per section before "Show more". */
const SECTION_LIMIT = 5;

const normalize = (text: string | undefined) => (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** A titled section of cards, capped with "Show more"; nothing at all when empty. */
function IdeasSection<T>({ title, items, children }: { title: string; items: T[]; children: (shown: T[]) => ReactNode }) {
  const capped = useCapped(items, SECTION_LIMIT);
  if (items.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <h2 className={SECTION_LABEL}>{title}</h2>
      {children(capped.shown)}
      <ShowMore hidden={capped.hidden} onClick={capped.showMore} />
    </section>
  );
}

/**
 * Muse's Ideas, as iPhone lists them: "Ready for you" (ideas the daily job prepared a draft for), "Ideas" and "Suggestions"
 * (Today's inspiration), each capped, filterable by agent. Each card names the agent, the idea, why it came up and, when
 * prepared, a draft that opens inline. "Do it" starts the agent on it in a new conversation and opens that conversation;
 * "Not now" snoozes it (not offered again for two weeks); "Less like this" writes a proactive rule (fewer about the topic,
 * fewer of this type, or never) and the toast offers Undo.
 */
export function IdeasPage() {
  const navigate = useNavigate();
  const { data: agents } = useAgents();
  const { data: open } = useOpenIdeas();
  const accept = useAcceptIdea();
  const feedback = useIdeaFeedback();
  const deleteRule = useDeleteProactiveRule();
  const { inspiration } = useToday();
  const [agentId, setAgentId] = useState("all");
  const wide = useWideLayout();
  const [draft, setDraft] = useState<{ path: string; label?: string | undefined }>();
  const known = new Map((agents ?? []).map((agent) => [agent.id, agent]));
  const inScope = (id: string | undefined) => agentId === "all" || id === agentId;
  const ideas = (open ?? []).filter((idea) => known.has(idea.agentId) && inScope(idea.agentId));
  const ready = ideas.filter((idea) => idea.prepared?.kind === "draft");
  const others = ideas.filter((idea) => idea.prepared?.kind !== "draft");
  // A suggestion made from an idea already listed above is not offered twice (by idea id, else by title).
  const shownIdeas = new Set(ideas.map((idea) => idea.id));
  const shownTexts = new Set(ideas.map((idea) => normalize(idea.text)));
  const suggestions = inspiration.filter(
    (card) => (agentId === "all" || card.agentId === agentId) && !shownIdeas.has(card.id) && !shownTexts.has(normalize(card.title)),
  );

  const doIt = async (idea: Idea) => {
    try {
      const started = await accept.mutateAsync(idea.id);
      if (started.conversationId) navigate(`/c/${started.conversationId}`);
    } catch {
      // A failed accept leaves the idea in the list, so the user can try again.
    }
  };
  const notNow = (idea: Idea) =>
    feedback.mutate(
      { id: idea.id, action: "not_now" },
      { onSuccess: () => toast(t("ideas.snoozed")), onError: () => toast.error(t("common.error")) },
    );
  const lessLikeThis = (idea: Idea, choice: LessChoice) =>
    feedback.mutate(
      { id: idea.id, action: choice.action, scope: choice.scope },
      {
        onSuccess: ({ rule }) => {
          if (!rule) return;
          toast(rule.text, {
            action: { label: t("ideas.undo"), onClick: () => deleteRule.mutate(rule.id, { onError: () => toast.error(t("common.error")) }) },
          });
        },
        onError: () => toast.error(t("common.error")),
      },
    );
  const ideaCards = (shown: Idea[]) => (
    <div className={CARD_GRID}>
      {shown.map((idea) => (
        <IdeaCard
          key={idea.id}
          idea={idea}
          agent={known.get(idea.agentId)}
          busy={accept.isPending || feedback.isPending}
          onDoIt={() => void doIt(idea)}
          onNotNow={() => notNow(idea)}
          onLess={(choice) => lessLikeThis(idea, choice)}
          onOpenDraft={wide ? setDraft : undefined}
        />
      ))}
    </div>
  );
  const content = (
    <div className={cn("flex w-full flex-col gap-6 px-4 pb-10", wide ? "max-w-5xl" : "mx-auto max-w-xl")}>
      {ideas.length === 0 && suggestions.length === 0 ? <EmptyState title={t("ideas.empty")} /> : null}
      <IdeasSection title={t("ideas.ready")} items={ready}>{ideaCards}</IdeasSection>
      <IdeasSection title={t("ideas.ideas")} items={others}>{ideaCards}</IdeasSection>
      <IdeasSection title={t("ideas.suggestions")} items={suggestions}>
        {(shown) => <InspirationCards cards={shown} bare />}
      </IdeasSection>
    </div>
  );

  return (
    <PageFrame title={t("ideas.title")} scope={<AgentScopeButton bubble agents={agents} value={agentId} onChange={setAgentId} />}>
      {wide ? (
        <SplitView
          list={content}
          detail={draft ? <DraftPane draft={draft} onClose={() => setDraft(undefined)} /> : undefined}
          listWidth={520}
          className={SPLIT_NO_DIVIDER}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">{content}</ScrollArea>
      )}
    </PageFrame>
  );
}

interface IdeaCardProps {
  idea: Idea;
  agent: Agent | undefined;
  busy: boolean;
  onDoIt: () => void;
  onNotNow: () => void;
  onLess: (choice: LessChoice) => void;
  /** Wide screens open a draft in the side pane instead of inline. */
  onOpenDraft?: ((draft: { path: string; label?: string | undefined }) => void) | undefined;
}

interface LessChoice {
  labelKey: string;
  action: "less" | "never";
  scope: "topic" | "type";
}

/** The three ways to ask for less, written out. */
const LESS_CHOICES: LessChoice[] = [
  { labelKey: "ideas.lessTopic", action: "less", scope: "topic" },
  { labelKey: "ideas.lessType", action: "less", scope: "type" },
  { labelKey: "ideas.never", action: "never", scope: "topic" },
];

function IdeaCard({ idea, agent, busy, onDoIt, onNotNow, onLess, onOpenDraft }: IdeaCardProps) {
  return (
    <SuggestionCard agent={agent} title={idea.text} reason={idea.why}>
      {idea.prepared?.kind === "draft" ? <IdeaDraft path={idea.prepared.ref} label={idea.prepared.label} onOpenPane={onOpenDraft} /> : null}
      <div className="flex flex-wrap justify-end gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="xs" variant="ghost" className="rounded-full" disabled={busy}>
              {t("ideas.lessLikeThis")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {LESS_CHOICES.map((choice) => (
              <DropdownMenuItem key={choice.labelKey} onSelect={() => onLess(choice)}>
                {t(choice.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="xs" variant="ghost" className="rounded-full" disabled={busy} onClick={onNotNow}>
          {cardLabel("notNow", idea.text)}
        </Button>
        <Button size="xs" className="rounded-full" disabled={busy} onClick={onDoIt}>
          {cardLabel("doIt", idea.text)}
        </Button>
      </div>
    </SuggestionCard>
  );
}

/** The draft an idea came with, collapsed to its title; the text loads when it opens. */
function IdeaDraft({ path, label, onOpenPane }: { path: string; label?: string | undefined; onOpenPane?: IdeaCardProps["onOpenDraft"] }) {
  const [open, setOpen] = useState(false);
  if (onOpenPane) {
    return (
      <button type="button" aria-label={t("ideas.openDraft")} onClick={() => onOpenPane({ path, label })} className="self-start rounded-sm text-sm text-muted-foreground hover:text-fg focus-ring">
        {t("ideas.draft", { name: label ?? path })}
      </button>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="px-0 py-0 text-muted-foreground">{t("ideas.draft", { name: label ?? path })}</CollapsibleTrigger>
      <CollapsibleContent className="px-0">{open ? <IdeaDraftText path={path} /> : null}</CollapsibleContent>
    </Collapsible>
  );
}

function IdeaDraftText({ path }: { path: string }) {
  const { file, isPending } = useHomeFile(path);
  return <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-bg/60 p-3 text-xs">{isPending ? "…" : (file?.content ?? t("ideas.draftGone"))}</pre>;
}

/** A draft read in full beside the cards (wide screens). */
function DraftPane({ draft, onClose }: { draft: { path: string; label?: string | undefined }; onClose: () => void }) {
  const { file, isPending } = useHomeFile(draft.path);
  return (
    <div className={cn("flex flex-col gap-4", DETAIL_COLUMN)}>
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-[22px] font-semibold leading-snug tracking-[-0.01em] text-fg">{draft.label ?? draft.path}</h2>
        <Button variant="ghost" size="icon" aria-label={t("ideas.closeDraft")} className="size-8 rounded-full text-fg-muted" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <pre className={cn("whitespace-pre-wrap p-4 text-sm text-fg", CARD_SURFACE)}>{isPending ? "…" : (file?.content ?? t("ideas.draftGone"))}</pre>
    </div>
  );
}
