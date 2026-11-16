import { ChevronRight, Brain, CalendarDays, IdCard, MessageSquareQuote, MessageSquareText, Users, type LucideIcon } from "lucide-react";
import { CARD_SURFACE } from "../../components/page/PageFrame";
import { t } from "../../lib/i18n";

export type TabId = "memory" | "about" | "people" | "daily" | "style" | "claims";

const FILES: Array<{ id: TabId; icon: LucideIcon }> = [
  { id: "memory", icon: Brain },
  { id: "about", icon: IdCard },
  { id: "people", icon: Users },
  { id: "daily", icon: CalendarDays },
  { id: "style", icon: MessageSquareText },
];
const CLAIMS: Array<{ id: TabId; icon: LucideIcon }> = [{ id: "claims", icon: MessageSquareQuote }];

function Card({ rows, onOpen }: { rows: typeof FILES; onOpen: (id: TabId) => void }) {
  return (
    <div className={`${CARD_SURFACE} divide-y divide-border/60 overflow-hidden`}>
      {rows.map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onOpen(id)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-interactive-hover focus-ring"
        >
          <Icon className="size-5 shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-fg">{t(`memories.tab.${id}`)}</span>
            <span className="block text-xs text-fg-subtle">{t(`memories.sub.${id}`)}</span>
          </span>
          <ChevronRight className="size-4 shrink-0 text-fg-subtle" />
        </button>
      ))}
    </div>
  );
}

/** The Memory page's list, as on the iPhone: the files agents keep, then the claims behind them. */
export function MemoryIndex({ onOpen }: { onOpen: (id: TabId) => void }) {
  return (
    <div className="max-w-2xl space-y-6 pt-1">
      <Card rows={FILES} onOpen={onOpen} />
      <Card rows={CLAIMS} onOpen={onOpen} />
    </div>
  );
}
