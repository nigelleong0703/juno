import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SettingsLayoutSection {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
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
}: SettingsLayoutProps) {
  return (
    <div
      data-slot="settings-layout"
      className={cn("flex min-h-screen flex-col bg-background md:flex-row", className)}
    >
      <nav
        aria-hidden={navCollapsed || undefined}
        className={cn(
          "w-full shrink-0 overflow-hidden border-b border-foreground/10 transition-[width] duration-200 ease-out md:w-56 md:border-b-0 md:border-r",
          navCollapsed && "md:w-0 md:border-r-0",
        )}
      >
        <div className="flex flex-row overflow-x-auto p-3 md:w-56 md:flex-col md:overflow-visible">
          {sections.map((section) => {
            const isActive = activeId === section.id;
            return (
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
                <span>{section.label}</span>
              </button>
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
