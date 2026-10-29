import type { DecisionCategory, DecisionPlatform } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { CalendarCheck, CreditCard, ListChecks, Lock, Megaphone, MessageSquare, Settings, Share, Trash2, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { CHARACTERS } from "../../characters";
import { BrandIcon } from "../BrandIcon";

/** The generic symbol of a kind of decision, for an approval that has no platform. */
export const CATEGORY_ICONS: Record<DecisionCategory, LucideIcon> = {
  spending: CreditCard,
  speaking: MessageSquare,
  public: Megaphone,
  committing: CalendarCheck,
  irreversible: Trash2,
  sensitive: Lock,
  sharing: Share,
  setup: Settings,
  choice: ListChecks,
};

const TILE = "flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-bg-subtle text-fg-muted";

/**
 * The main icon of an approval: where it lands. A connector shows its brand icon, a site its own icon (the host's first
 * letter when it has none), Juno the bean, and no platform the symbol of the kind of decision.
 */
export function PlatformIcon({ platform, category, className }: { platform: DecisionPlatform; category?: DecisionCategory; className?: string }) {
  const [broken, setBroken] = useState(false);
  const initial = (
    <span className={cn(TILE, "text-sm font-semibold uppercase", className)} aria-hidden>
      {(platform.host ?? platform.name).charAt(0)}
    </span>
  );
  if (platform.kind === "connector") {
    return platform.catalogId ? <BrandIcon id={platform.catalogId} className={cn("rounded-lg", className)} /> : initial;
  }
  if (platform.kind === "site") {
    return platform.iconUrl && !broken ? (
      <span className={cn(TILE, className)}>
        <img src={platform.iconUrl} alt="" className="size-[60%] object-contain" onError={() => setBroken(true)} draggable={false} />
      </span>
    ) : (
      initial
    );
  }
  if (platform.kind === "juno") {
    return (
      <span className={cn(TILE, className)}>
        <img src={CHARACTERS.bean.poster} alt="" className="size-full object-cover" draggable={false} />
      </span>
    );
  }
  const Icon = CATEGORY_ICONS[category ?? "choice"];
  return (
    <span className={cn(TILE, className)}>
      <Icon className="size-[45%]" />
    </span>
  );
}
