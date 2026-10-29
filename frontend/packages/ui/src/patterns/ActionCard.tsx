import { ChevronRight } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The action-card kit (VISUAL.md "Request cards"): one white card, a 28px type icon with a bold
 * "<Type> · <Agent> wants to …" header, muted guidance, then any of Preview / Tile / TextRow and
 * an equal-width button pair. Every request kind (purchase, send, question, secure input, take
 * over, guard) is built from these parts, so they all read as one family.
 */
export function ActionCard({ className, children, ...rest }: { className?: string; children: ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return (
    <div
      data-slot="action-card"
      {...rest}
      className={cn(
        "w-full max-w-[560px] rounded-[28px] border border-foreground/10 bg-white px-4 pb-4 pt-[22px] text-foreground",
        "shadow-[0_1px_2px_rgba(0,0,0,.04),0_12px_28px_-14px_rgba(0,0,0,.10)] dark:bg-[#181818] dark:shadow-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** The card's header: a 28px type icon, or `leading` (a brand icon) instead, then the title. `above` / `below` sit over / under the title. */
export function ActionCardHeader({
  icon: Icon,
  leading,
  above,
  below,
  children,
}: {
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  leading?: ReactNode;
  above?: ReactNode;
  below?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-1">
      {leading ?? (Icon ? <Icon className="size-7 shrink-0" strokeWidth={1.7} /> : null)}
      <div className="min-w-0 flex-1">
        {above}
        <h3 className="pt-px text-[15.5px] font-semibold leading-[21px] tracking-[-0.008em]">{children}</h3>
        {below}
      </div>
    </div>
  );
}

export function ActionCardGuidance({ children }: { children: ReactNode }) {
  return <p className="mx-1 mt-3 text-[13px] leading-[18px] text-foreground/60">{children}</p>;
}

/** One short muted line under the summary (the server's `notice`, e.g. a privacy reminder). Renders nothing without text. */
export function ActionCardNotice({ notice }: { notice?: string | undefined }) {
  if (!notice) return null;
  return <p className="mx-1 mt-1 text-xs leading-4 text-foreground/45">{notice}</p>;
}

/** A rounded 16px frame for a screenshot, a draft or any content, with an optional floating chip. */
export function ActionCardPreview({ children, chip, className }: { children: ReactNode; chip?: ReactNode; className?: string }) {
  return (
    <div className={cn("relative mt-4 overflow-hidden rounded-2xl border border-foreground/[0.07] bg-[#fafafa] dark:bg-[#121212]", className)}>
      {children}
      {chip ? <div className="absolute bottom-3 right-3">{chip}</div> : null}
    </div>
  );
}

/** The floating white pill on a preview (Live, Edit, Review order). */
export function ActionCardChip({ children, onClick, label }: { children: ReactNode; onClick?: () => void; label?: string }) {
  const cls =
    "inline-flex h-7 items-center gap-1.5 rounded-full bg-white/95 px-3 text-[13px] leading-5 text-[#3a3a3a] shadow-[0_1px_2px_rgba(0,0,0,.08),0_4px_14px_rgba(0,0,0,.10)] backdrop-blur-sm dark:bg-[#282828]/95 dark:text-[#e8e8e8] dark:shadow-[0_0_0_1px_rgba(252,252,252,.08),0_4px_14px_rgba(0,0,0,.4)]";
  if (!onClick) return <span className={cls}>{children}</span>;
  return (
    <button type="button" aria-label={label} onClick={onClick} className={cn(cls, "cursor-pointer focus-ring")}>
      {children}
    </button>
  );
}

/** A 20px-radius grey tile: a leading visual, one or two lines of text, an optional trailing slot. */
export function ActionCardTile({
  leading,
  title,
  subtitle,
  mono,
  trailing,
  className,
}: {
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  mono?: boolean;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mt-3 flex min-h-16 items-center gap-3.5 rounded-[20px] bg-[#f4f4f4] px-4 py-3 dark:bg-[#242424]", className)}>
      {leading ? <div className="grid shrink-0 place-items-center">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className={cn("text-base leading-[21px] tracking-[-0.01em]", mono && "break-all font-mono text-[13.5px] leading-5 tracking-normal")}>{title}</div>
        {subtitle ? <div className="mt-px flex items-center gap-1.5 text-[13px] leading-[18px] text-foreground/60">{subtitle}</div> : null}
      </div>
      {trailing}
    </div>
  );
}

/** A plain label / value line (totals): no tile, just text. */
export function ActionCardTextRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between px-1 pb-2.5 pt-3.5 text-[15px] leading-[22px]">
      <span>{label}</span>
      <b className="font-semibold">{value}</b>
    </div>
  );
}

export interface ActionCardButton {
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

/** Equal-width pair: secondary grey on the left (optional), primary black / white on the right (optional: a lone secondary fills the row). */
export function ActionCardButtons({ secondary, primary, className }: { secondary?: ActionCardButton; primary?: ActionCardButton; className?: string }) {
  const base = "h-[38px] flex-1 rounded-full text-[15px] font-medium tracking-[-0.005em] transition-colors disabled:opacity-50 focus-ring";
  return (
    <div className={cn("mt-4 flex gap-2.5", className)}>
      {secondary ? (
        <button type="button" disabled={secondary.disabled} onClick={secondary.onClick} className={cn(base, "bg-[#f1f1f1] text-foreground hover:bg-[#e8e8e8] dark:bg-[#2a2a2a] dark:hover:bg-[#333]")}>
          {secondary.label}
        </button>
      ) : null}
      {primary ? (
        <button
          type="button"
          disabled={primary.disabled}
          onClick={primary.onClick}
          className={cn(base, "bg-[#070707] font-semibold text-[#fcfcfc] hover:bg-[#2f2f2f] dark:bg-[#fafafa] dark:text-[#070707] dark:hover:bg-[#d5d5d5]")}
        >
          {primary.label}
        </button>
      ) : null}
    </div>
  );
}

/** A choice chip for a question (one of several answers). */
export function ActionCardOption({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={cn(
        "inline-flex h-[38px] items-center gap-2 rounded-full bg-[#f4f4f4] px-4 text-sm dark:bg-[#242424] focus-ring",
        selected && "bg-white font-semibold shadow-[inset_0_0_0_1.5px_#070707] dark:bg-[#181818] dark:shadow-[inset_0_0_0_1.5px_#fafafa]",
      )}
    >
      {children}
    </button>
  );
}

/**
 * The resolved state, iOS `ResolvedCardRow`: one slim card (28px outcome disc, "Title · detail", chevron that turns
 * 90deg when open). Tapping the row toggles; `children` expand in place with a 200ms height animation.
 */
export function ActionSummaryRow({
  tone,
  title,
  detail,
  expanded = false,
  onToggle,
  icon,
  children,
  className,
}: {
  tone: "success" | "danger" | "neutral";
  title: ReactNode;
  detail?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  icon: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="action-summary"
      className={cn(
        "w-full max-w-[560px] rounded-[22px] border-[0.5px] border-foreground/15 bg-white px-4 py-3 text-foreground dark:bg-[#181818]",
        className,
      )}
    >
      <button type="button" aria-expanded={expanded} onClick={onToggle} className="flex w-full items-center gap-3 rounded-full text-left text-[15px] leading-5 focus-ring">
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-full text-white [&_svg]:size-3.5",
            tone === "success" && "bg-success",
            tone === "danger" && "bg-danger",
            tone === "neutral" && "bg-fg-subtle",
          )}
        >
          {icon}
        </span>
        <span className={cn("min-w-0 flex-1", !expanded && "truncate")}>
          <b className="font-semibold">{title}</b>
          {detail ? <span className="text-fg-muted"> · {detail}</span> : null}
        </span>
        <ChevronRight
          aria-hidden
          className={cn("size-4 shrink-0 text-fg-subtle transition-transform duration-200 motion-reduce:transition-none", expanded && "rotate-90")}
        />
      </button>
      <div
        data-open={expanded ? "true" : undefined}
        className="grid grid-rows-[0fr] transition-[grid-template-rows] duration-200 motion-reduce:transition-none data-[open=true]:grid-rows-[1fr]"
      >
        <div className="min-h-0 overflow-hidden" aria-hidden={!expanded} inert={!expanded}>
          {children ? <div className="pt-3">{children}</div> : null}
        </div>
      </div>
    </div>
  );
}
