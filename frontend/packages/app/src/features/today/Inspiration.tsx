import type { Inspiration } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { ChevronDown, ChevronRight, Monitor, Sparkles, User } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useApps } from "../../data/apps";
import { useAgents, useConversations } from "../../data/queries";
import { useDismissInspiration } from "../../data/today";
import { CHARACTER_TINT } from "../../lib/avatars";
import { cardLabel, t } from "../../lib/i18n";
import { BrandIcon } from "../../components/BrandIcon";
import { SuggestionCard } from "../ideas/SuggestionCard";
import { useUiStore } from "../../store/ui";

/** The soft pink, purple and blue of the Today glow, also the tints of cards that belong to no agent. */
export const GLOW_TINTS = [CHARACTER_TINT.pink, CHARACTER_TINT.purple, CHARACTER_TINT.blue];

/** Cards in a column on a phone-width screen, in as many columns as fit on a wide one. */
export const CARD_GRID = "grid grid-cols-1 gap-2.5 lg:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]";

/** What a card's button does: open the connector, computer or profile it unlocks, or start the chat with the text in its composer. */
function useInspirationAction(): (card: Inspiration) => void {
  const navigate = useNavigate();
  const { data: conversations } = useConversations();
  const setComposerPrefill = useUiStore((state) => state.setComposerPrefill);
  const setStarterText = useUiStore((state) => state.setStarterText);
  const setComputerPanelOpen = useUiStore((state) => state.setComputerPanelOpen);

  return (card) => {
    const { action } = card;
    if (action.type === "unlock") {
      if (action.target === "connector") navigate(action.connectorId ? `/apps/${encodeURIComponent(action.connectorId)}` : "/apps");
      else if (action.target === "profile") navigate("/settings/details");
      else if (action.agentId) {
        setComputerPanelOpen(true);
        navigate(`/agents/${action.agentId}`);
      }
      return;
    }
    if (!action.agentId) {
      setStarterText(action.text);
      navigate("/new");
      return;
    }
    const chat = conversations?.find((c) => c.kind === "direct" && c.agentIds.includes(action.agentId as string));
    if (chat) {
      setComposerPrefill({ conversationId: chat.id, text: action.text });
      navigate(`/c/${chat.id}`);
    } else {
      navigate(`/agents/${action.agentId}`);
    }
  };
}

/**
 * Things to try, from `today.inspiration`: every card the server sends (at most 3). Only the card's button acts; the
 * body is inert. Renders nothing when there are none.
 */
export function InspirationCards({ cards, bare = false }: { cards: Inspiration[]; /** No heading: the caller titles the section. */ bare?: boolean }) {
  const { data: agents } = useAgents();
  const perform = useInspirationAction();
  const dismiss = useDismissInspiration();
  if (cards.length === 0) return null;

  return (
    <section aria-label={t("inspiration.title")} className="flex flex-col gap-2">
      {bare ? null : <h2 className="text-sm font-semibold text-fg-muted">{agents?.length ? t("inspiration.title") : t("inspiration.start")}</h2>}
      <ul className={CARD_GRID}>
        {cards.map((card, index) => {
          const unlock = card.action.type === "unlock";
          return (
            <li key={card.id}>
              <SuggestionCard
                agent={unlock ? undefined : agents?.find((a) => a.id === card.agentId)}
                fallbackLeading={unlock ? <UnlockTile card={card} /> : <NoAgentTile tint={GLOW_TINTS[index % GLOW_TINTS.length] as string} />}
                title={card.title}
                reason={card.reason}
                actionLabel={unlock ? card.prompt : cardLabel("start", `${card.title} ${card.prompt}`)}
                onAction={() => perform(card)}
                onDismiss={() => dismiss.mutate(card.id)}
                dismissLabel={t("inspiration.dismiss")}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The leading of a suggestion no agent is picked for yet (iPhone's InspirationTile). */
function NoAgentTile({ tint }: { tint: string }) {
  return (
    <span style={{ backgroundColor: `${tint}33` }} className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted">
      <Sparkles className="size-3.5" />
    </span>
  );
}

/** The leading of an unlock card: the connector's icon, a monitor for a computer, a person for the profile. */
function UnlockTile({ card }: { card: Inspiration }) {
  const { data: apps } = useApps();
  const { action } = card;
  if (action.type !== "unlock") return null;
  if (action.target === "connector") {
    const app = apps?.find((c) => c.id === action.connectorId);
    return <BrandIcon id={app?.id} symbol={app?.icon} className="size-6" />;
  }
  const Icon = action.target === "computer" ? Monitor : User;
  return (
    <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-fg-muted">
      <Icon className="size-3.5" />
    </span>
  );
}

const FOR_YOU_KEY = "today.forYouCollapsed";

/** `localStorage` can be blocked; the section then just starts expanded each time. */
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(FOR_YOU_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * "For you" (iPhone's ForYouHeader): a header that collapses the suggestion cards, with their count and an "All" link to
 * the Ideas page. The collapse state is remembered per browser.
 */
export function ForYou({ cards, className }: { cards: Inspiration[]; className?: string }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  if (cards.length === 0) return null;
  const toggle = () => {
    try {
      localStorage.setItem(FOR_YOU_KEY, collapsed ? "0" : "1");
    } catch {
      // Not remembered; fine.
    }
    setCollapsed(!collapsed);
  };
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between">
        <button type="button" aria-expanded={!collapsed} onClick={toggle} className="flex h-9 items-center gap-1.5 rounded-md text-sm font-semibold text-fg-muted focus-ring">
          {t("inspiration.forYou")}
          <span className="font-normal text-fg-subtle">{cards.length}</span>
          <ChevronDown className={cn("size-3.5 transition-transform motion-reduce:transition-none", collapsed && "-rotate-90")} />
        </button>
        <Link to="/ideas" className="flex h-9 items-center gap-0.5 rounded-md text-sm text-fg-muted focus-ring">
          {t("inspiration.all")}
          <ChevronRight className="size-3.5" />
        </Link>
      </div>
      {collapsed ? null : <InspirationCards cards={cards} bare />}
    </div>
  );
}
