import { SettingsLayout, cn, type SettingsLayoutSection } from "@agent-desktop/ui";
import type { ReactNode } from "react";
import { useUiStore } from "../store/ui";

export interface SettingsPageProps {
  sections: SettingsLayoutSection[];
  activeId?: string;
  onSelect?: (id: string) => void;
  children: ReactNode;
  className?: string;
  /** The content is a page of its own (own header and scrolling). */
  bare?: boolean;
}

/**
 * The Settings template (ARCHITECTURE §5.5): the ui `SettingsLayout` sidebar plus a content
 * panel, sized to the shell. App settings and per-agent settings share it.
 */
export function SettingsPage({ sections, activeId, onSelect, children, className, bare }: SettingsPageProps) {
  const navCollapsed = useUiStore((state) => state.sidebarCollapsed);
  return (
    <SettingsLayout
      sections={sections}
      activeId={activeId}
      onSelect={onSelect}
      navCollapsed={navCollapsed}
      {...(bare ? { bare } : {})}
      className={cn("h-full min-h-0", className)}
    >
      {children}
    </SettingsLayout>
  );
}
