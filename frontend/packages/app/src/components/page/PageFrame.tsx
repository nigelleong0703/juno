import { cn, IconButton, PageHeader, type IconButtonProps } from "@agent-desktop/ui";
import type { ComponentType, ReactNode } from "react";

/** The shared page look (iPhone's TabHeader): a transparent 52px bar with trailing controls, then a large heading. */
export function PageFrame({ title, subtitle, back, scope, actions, fullWidth = false, className, children }: { title: ReactNode; /** The page's agent scope, centred in the header. */ scope?: ReactNode; /** Split list/detail pages span the whole width; others sit in a centred column. */ fullWidth?: boolean; subtitle?: ReactNode; /** A sub-page's way back, at the leading edge of the header. */ back?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div data-slot="page-frame" className={cn("relative flex h-full min-h-0 flex-col bg-bg", className)}>
      {/* The chat header's form: the header floats over the page, its own surface solid and feathering into the content,
          which scrolls up behind it (page-frame.css pulls the scroller up under the header). */}
      <div aria-hidden className="page-frame-fade pointer-events-none absolute inset-x-0 top-0 z-[9]" />
      {/* The header's empty space drags the window on desktop (the shell's drag strip, AppShell); its controls opt out. */}
      <PageHeader title={title} subtitle={subtitle} back={back} scope={scope} actions={actions} fullWidth={fullWidth} />
      <div data-slot="page-body" className="flex min-h-0 flex-1 flex-col">
        {fullWidth ? children : <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col">{children}</div>}
      </div>
    </div>
  );
}

/** A page action: round ghost icon button, 32px, icon 16px, label as tooltip. */
export function PageAction({ icon: Icon, iconClassName, ...props }: Omit<IconButtonProps, "children"> & { icon: ComponentType<{ className?: string }>; iconClassName?: string }) {
  return (
    <IconButton side="bottom" className="rounded-full text-fg-muted" {...props}>
      <Icon className={cn("size-4", iconClassName)} />
    </IconButton>
  );
}

/** The card surface shared by lists and reading panes: muted fill, 16px radius, no border; hover and selected states. */
export const CARD_SURFACE = "rounded-2xl bg-muted/70 transition-colors duration-150 motion-reduce:transition-none";
export const CARD_INTERACTIVE = "hover:bg-interactive-hover";
export const CARD_SELECTED = "ring-[1.5px] ring-fg/30";

/** A section label inside a page: 13px semibold muted. */
export const SECTION_LABEL = "px-1 text-[13px] font-semibold text-fg-muted";

/** The list/detail split without the divider, and the centred reading column of its detail pane. */
export const SPLIT_NO_DIVIDER = "[&_[data-slot=split-view-list]]:border-r-0";
export const DETAIL_COLUMN = "mx-auto w-full max-w-[720px] px-8 pb-10 pt-8";

/** Classes for a card or row on the shared surface. */
export function cardClass({ interactive = false, selected = false }: { interactive?: boolean; selected?: boolean } = {}) {
  return cn(CARD_SURFACE, interactive && CARD_INTERACTIVE, selected && CARD_SELECTED);
}
