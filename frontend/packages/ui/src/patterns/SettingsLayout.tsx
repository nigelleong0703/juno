import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsLayoutSection {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** A heading shown above this entry when it differs from the previous entry's group. */
  group?: string;
  /** Shown in place of the button: a block of the list that is not a page (a status row, a switch). */
  block?: ReactNode;
  /** Shown at the end of the row (a chevron when the entry opens a page of its own). */
  trailing?: ReactNode;
}

export interface SettingsLayoutProps {
  sections: SettingsLayoutSection[];
  activeId?: string;
  onSelect?: (id: string) => void;
  children: ReactNode;
  className?: string;
  /** Hides the section nav (the shell's sidebar toggle drives it). */
  navCollapsed?: boolean;
  /** The children bring their own header, scrolling and width (a sub-section that is a page of its own). */
  bare?: boolean;
  /** Rendered above the section entries (an account block). */
  navHeader?: ReactNode;
  /** A wider nav column (a full settings list rather than a short section list). */
  wide?: boolean;
}

/** Two-pane settings shell: section nav plus content area. */
export function SettingsLayout({
  sections,
  activeId,
  onSelect,
  children,
  className,
  navCollapsed = false,
  bare = false,
  navHeader,
  wide = false,
}: SettingsLayoutProps) {
  return (
    <div
      data-slot="settings-layout"
      className={cn("flex min-h-screen flex-col bg-background md:flex-row", className)}
    >
      <nav
        aria-hidden={navCollapsed || undefined}
        className={cn(
          "w-full shrink-0 overflow-hidden border-b border-foreground/10 transition-[width] duration-200 ease-out md:border-b-0 md:border-r",
          wide ? "md:w-80" : "md:w-56",
          navCollapsed && "md:w-0 md:border-r-0",
        )}
      >
        <div className={cn("flex flex-row overflow-x-auto p-3 md:flex-col md:overflow-y-auto md:overflow-x-hidden", wide ? "md:w-80" : "md:w-56")}>
          {navHeader}
          {sections.map((section, index) => {
            const isActive = activeId === section.id;
            const heading = section.group !== undefined && section.group !== sections[index - 1]?.group ? section.group : undefined;
            const title = heading === undefined ? null : (
              <div className="hidden px-2 pb-1 pt-4 text-xs font-medium text-muted-foreground md:block">{heading}</div>
            );
            if (section.block !== undefined) {
              return (
                <div key={section.id} className="contents">
                  {title}
                  {section.block}
                </div>
              );
            }
            return (
              <div key={section.id} className="contents">
              {title}
              <button
                key={section.id}
                type="button"
                onClick={() => onSelect?.(section.id)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex h-8 flex-1 items-center gap-2 whitespace-nowrap rounded-md px-2 text-sm font-medium",
                  "transition-colors duration-150 ease-out md:w-full md:flex-none",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
                  isActive
                    ? "bg-interactive-selected text-foreground"
                    : "text-muted-foreground hover:bg-interactive-hover hover:text-foreground active:bg-interactive-pressed",
                )}
              >
                {section.icon && <span className="size-4 shrink-0">{section.icon}</span>}
                <span className="min-w-0 flex-1 truncate text-left">{section.label}</span>
                {section.trailing}
              </button>
              </div>
            );
          })}
        </div>
      </nav>

      {bare ? (
        <div key={activeId} className="min-h-0 min-w-0 flex-1 animate-in fade-in-0 duration-200 motion-reduce:animate-none">{children}</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div key={activeId} className="mx-auto max-w-2xl animate-in fade-in-0 p-6 duration-200 motion-reduce:animate-none">{children}</div>
        </div>
      )}
    </div>
  );
}
