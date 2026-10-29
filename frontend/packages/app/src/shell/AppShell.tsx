import { IconButton, Sheet, SheetContent, SheetDescription, SheetTitle, cn, useIsMobile } from "@agent-desktop/ui";
import { Menu } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { usePlatform } from "../data/ClientProvider";
import { DragStrip } from "../components/DragStrip";
import { noDragRegion } from "../lib/drag";
import { t } from "../lib/i18n";
import { MAC_WINDOW_CORNER_RADIUS_PX, RAIL_PANEL_RADIUS_PX, resolveShellRailWidth } from "../lib/windowChrome";
import { useUiStore } from "../store/ui";
import { CommandPalette } from "./CommandPalette";
import { ComputerPaneSlot, type ComputerPaneSlotProps } from "./ComputerPaneSlot";
import { GlobalHotkeys } from "./GlobalHotkeys";
import { NotificationBridge } from "./NotificationBridge";
import { PanelComponent, PanelGroup, PanelSeparator } from "./Panels";
import { Sidebar } from "./Sidebar";
import { AppRail } from "./AppRail";
import { ShellTopBar } from "./ShellTopBar";
import { SIDEBAR_MAX } from "./shellFrame";
import { useReportTimeZone } from "./useReportTimeZone";
import { useRouteConversation } from "./useRouteConversation";
import { useShellTracks } from "./useShellTracks";
import { useShellWidth } from "./useShellWidth";

/**
 * The application shell (ARCHITECTURE 修订 v0.3, owner feedback 2026-10-05): there is NO global
 * toolbar. The three columns — chat list · conversation · the agent's computer — run the full
 * height of the window and each draws its own shared-header top row, so the sidebar surface reaches the
 * macOS traffic lights and the chat/pane headers line up with it. Drag regions live in those
 * rows (lib/drag.ts), never in a separate bar.
 *
 * Track geometry and the collapse animation live in `useShellTracks`; route resolution in
 * `useRouteConversation`. Columns sit in an actual three-column CSS Grid
 * (`grid-template-columns: <sidebar> minmax(0, 1fr) <computer>`, see app.css
 * `.shell-grid`); the drag handles are absolute overlays on the boundaries, never tracks.
 */
export interface AppShellProps {
  /** Planned agent status pane; see `ComputerPaneSlotProps.renderPane`. */
  renderPane?: ComputerPaneSlotProps["renderPane"];
}

export function AppShell({ renderPane }: AppShellProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const shellWidth = useShellWidth(shellRef);

  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const computerPanelOpen = useUiStore((state) => state.computerPanelOpen);
  const { conversationId, agentId } = useRouteConversation();
  const navigate = useNavigate();
  const platform = usePlatform();
  const { pathname } = useLocation();
  // Phone width: only the chat shows. The icon rail and the chat list move behind a menu button; the computer
  // pane stays closed until opened.
  const narrow = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (narrow) useUiStore.getState().setComputerPanelOpen(false);
  }, [narrow]);
  /**
   * The chat list belongs to the chat surface (owner request 2026-10-17, re-confirmed
   * 2026-10-21): other pages carry their own sidebar or none. The top-row toggle shows and
   * hides whichever sidebar the current page has — the chat list here, a settings page's
   * section nav there — and does nothing on a page without one.
   */
  const chatSurface = pathname === "/chat" || pathname === "/new" || pathname.startsWith("/c/");
  /**
   * Away from the chat surface the chat list's track is 0, so the conversation column is the
   * panel beside the icon rail and must carry the corner the chat list would have had
   * (owner feedback 2026-10-21: the corner below the traffic lights vanished on Feed).
   */
  const railPanel = !narrow && !chatSurface;
  useReportTimeZone();
  /** Actual collapsed rail (lib/windowChrome): 96px on native Mac, 84px in the browser. */
  const railWidth = resolveShellRailWidth(platform.hasTrafficLights);
  const tracks = useShellTracks({
    sidebarCollapsed,
    sidebarVisible: chatSurface,
    computerPanelOpen,
    conversationId,
    agentId,
    shellWidth,
    railWidth,
    narrow,
    shellRef,
  });

  /** "+" and ⌘N open the compose draft (#/new); the draft creates the agent on send. */
  const openCompose = () => navigate("/new");

  // The grid tracks above are state-driven: toggling a preference re-renders
  // the columns (animated through the track hook) instead of driving an
  // imperative panel API, so the conversation column never remounts and the
  // transcript keeps its scroll anchor.

  /**
   * Owner feedback 2026-10-05: opening or closing the computer pane must not remount the
   * conversation column - a reader who had scrolled up lost their place when the whole shell's
   * subtree was replaced. The pane is therefore a permanent panel that collapses to 0 width
   * instead of a conditional child, so all three columns stay permanently mounted and the
   * transcript inside the middle column keeps its scroll anchor while the pane appears
   * and disappears.
   */
  return (
    <div data-slot="app-shell" className="relative flex h-screen w-screen flex-col overflow-hidden bg-bg text-fg">
      <ShellTopBar />
      <div data-slot="shell-body" className="flex min-h-0 min-w-0 flex-1">
        {narrow ? null : <AppRail />}
        <div ref={shellRef} className="min-h-0 min-w-0 flex-1">
          <PanelGroup
            id="shell"
            data-animating={tracks.animating ? "true" : undefined}
            style={{ display: "grid", gridTemplateColumns: tracks.gridTemplateColumns }}
          >
            <PanelComponent
              id="sidebar"
              className="overflow-hidden"
            >
              {narrow ? null : <Sidebar collapsedOverride={tracks.displayedCollapsed} />}
            </PanelComponent>

          {chatSurface && !narrow && (
            <PanelSeparator
              label="Resize chat list"
              onDoubleClick={tracks.handleSidebarSeparatorDoubleClick}
              onResizeBy={tracks.handleSidebarResizeBy}
              bare
              style={tracks.sidebarSeparatorStyle}
              valueMin={railWidth}
              valueMax={SIDEBAR_MAX}
              valueNow={tracks.sidebarWidth}
              valueText={tracks.effectiveCollapsed ? "collapsed" : `${tracks.sidebarWidth} pixels`}
              controls="sidebar conversation"
            />
          )}

            <PanelComponent
              id="conversation"
              className={cn("min-w-0 overflow-hidden", !railPanel && "bg-panel")}
              data-rail-panel={railPanel ? "" : undefined}
            >
              <main
                data-computer={tracks.displayedComputer ? "" : undefined}
                className="relative isolate flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-bg"
                style={{
                  borderTopRightRadius: tracks.displayedComputer
                    ? MAC_WINDOW_CORNER_RADIUS_PX
                    : 0,
                  // Away from the chat surface the chat list's track is 0, so this column is
                  // the panel beside the icon rail and carries the corner the chat list
                  // would have had (owner feedback 2026-10-21: the corner below the traffic
                  // lights vanished on Feed).
                  borderTopLeftRadius: railPanel ? RAIL_PANEL_RADIUS_PX : 0,
                  borderBottomLeftRadius: railPanel ? RAIL_PANEL_RADIUS_PX : 0,
                }}
              >
                <DragStrip />
                {/* Pages cross-fade in; the chat surface keeps one key so a conversation never remounts. */}
                <div key={chatSurface ? "chat" : pathname.split("/")[1]} className="flex min-h-0 flex-1 flex-col animate-in fade-in-0 duration-200 motion-reduce:animate-none">
                  <Outlet />
                </div>
              </main>
            </PanelComponent>

            {tracks.displayedComputer && !narrow && (
              <PanelSeparator
                label="Resize computer pane"
                onResizeBy={tracks.handleComputerResizeBy}
                bare
                style={tracks.computerSeparatorStyle}
                valueMin={tracks.computerBounds.min}
                valueMax={tracks.computerBounds.max}
                valueNow={tracks.computerWidth}
                valueText={`${tracks.computerWidth} pixels`}
                controls="conversation computer"
              />
            )}
            <PanelComponent
              id="computer"
              className="relative overflow-hidden bg-panel"
              hidden={!tracks.showComputer}
            >
              <DragStrip />
              {tracks.showComputer && agentId && conversationId && (
                <ComputerPaneSlot agentId={agentId} conversationId={conversationId} renderPane={renderPane} />
              )}
            </PanelComponent>
          </PanelGroup>
        </div>
      </div>

      {narrow ? (
        <>
          <IconButton
            label={t("sidebar.show")}
            style={noDragRegion}
            onClick={() => setMenuOpen(true)}
            className="fixed left-2 top-2 z-30 size-9 rounded-full text-fg-muted"
          >
            <Menu className="size-[18px]" />
          </IconButton>
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetContent side="left" showCloseButton={false} className="w-[min(320px,86vw)] gap-0 p-0">
              <SheetTitle className="sr-only">{t("sidebar.show")}</SheetTitle>
              <SheetDescription className="sr-only">{t("nav.destinations")}</SheetDescription>
              <Sidebar collapsedOverride={false} showNavigation />
            </SheetContent>
          </Sheet>
        </>
      ) : null}

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onNewAgent={openCompose} />
      <GlobalHotkeys
        onOpenPalette={() => setPaletteOpen((open) => !open)}
        onNewAgent={openCompose}
      />
      <NotificationBridge />
    </div>
  );
}
