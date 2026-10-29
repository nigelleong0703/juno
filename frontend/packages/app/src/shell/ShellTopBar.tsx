import { IconButton, cn } from "@agent-desktop/ui";
import { PanelLeft } from "lucide-react";
import { useLocation } from "react-router";
import { usePlatform } from "../data/ClientProvider";
import { dragRegion } from "../lib/drag";
import { t } from "../lib/i18n";
import {
  SHELL_HEADER_HEIGHT_PX,
  TRAFFIC_GROUP_WIDTH_PX,
  TRAFFIC_LIGHT_POSITION,
} from "../lib/windowChrome";
import { useUiStore } from "../store/ui";

/** Gap between the native traffic-light group and the first control. */
const EDGE_GAP_PX = 8;

/**
 * The shell's top row (owner reference 2026-10-17, Codex form): one full-width row above the
 * rail and the app column, holding the chat list's collapse toggle.
 *
 * Both builds draw it, so the two shells are the same structure: the browser has no native
 * traffic lights, so it simply insets. On the desktop the lights are window-space geometry
 * (x18 + the 60px group), so the toggle clears them.
 */
/** The pages that carry a sidebar the toggle can show or hide: the chat surface's chat list and a settings page's section nav. */
function pageHasSidebar(pathname: string): boolean {
  return pathname === "/chat" || pathname === "/new" || pathname.startsWith("/c/") || pathname.startsWith("/settings") || pathname.startsWith("/library") || pathname.startsWith("/team") || /^\/(automations|rules|memories|usage)(\/|$)/.test(pathname) || /^\/agents\/[^/]+\/settings/.test(pathname);
}

export function ShellTopBar() {
  const { pathname } = useLocation();
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  // The model gate is a full-window first-run screen (like onboarding): no top row, no toggle.
  const gate = useUiStore((state) => state.modelGateOpen);
  const platform = usePlatform();
  const inset = platform.hasTrafficLights
    ? TRAFFIC_LIGHT_POSITION.x + TRAFFIC_GROUP_WIDTH_PX + EDGE_GAP_PX
    : EDGE_GAP_PX;

  if (gate) return null;

  return (
    <header
      data-slot="shell-topbar"
      style={{ ...dragRegion, paddingLeft: inset }}
      className={cn(
        "relative z-20 flex min-w-0 shrink-0 select-none items-center gap-1 bg-sidebar pr-2",
        "h-[var(--shell-header-height)]",
      )}
    >
      {pageHasSidebar(pathname) && <IconButton
        label={collapsed ? `${t("sidebar.show")}  ⌘B` : `${t("sidebar.hide")}  ⌘B`}
        side="bottom"
        onClick={toggleSidebar}
        className="size-8 shrink-0 rounded-full text-fg-muted hover:bg-sidebar-accent/60"
      >
        <PanelLeft className="size-[18px]" />
      </IconButton>}
    </header>
  );
}

/** The shared header height, in px — the top row and the columns' own headers agree. */
export const SHELL_HEADER_HEIGHT = SHELL_HEADER_HEIGHT_PX;
