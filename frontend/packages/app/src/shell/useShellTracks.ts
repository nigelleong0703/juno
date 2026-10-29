import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  CHAT_MIN_WIDTH,
  COMPUTER_DEFAULT_WIDTH,
  clampComputerWidth,
  computerWidthBounds,
} from "../lib/shellLayout";
import { useUiStore } from "../store/ui";
import { SIDEBAR_MAX, SIDEBAR_MIN, cancelFrame, nextFrame } from "./shellFrame";

export interface ShellTracks {
  effectiveCollapsed: boolean;
  showComputer: boolean;
  displayedCollapsed: boolean;
  displayedComputer: boolean;
  animating: boolean;
  sidebarWidth: number;
  computerWidth: number;
  computerBounds: { min: number; max: number };
  gridTemplateColumns: string;
  sidebarSeparatorStyle: CSSProperties;
  computerSeparatorStyle: CSSProperties;
  handleSidebarResizeBy: (dx: number) => void;
  handleComputerResizeBy: (dx: number) => void;
  handleSidebarSeparatorDoubleClick: () => void;
}

/**
 * Three-column track geometry + collapse animation (owner feedback 2026-10-05):
 * chat list 280 (240-400, collapsing to the platform rail), right pane 560
 * (minimum 420 when space permits). Displayed tracks lag one frame behind toggles
 * so the CSS transition actually runs; drags cancel the animation and write sizes
 * straight through. Opening the computer folds the list to its rail as a temporary
 * layout mode — the persisted preference is never written.
 */
export function useShellTracks(params: {
  sidebarCollapsed: boolean;
  /** False away from the chat surface: the list's track is 0 and only the icon rail shows. */
  sidebarVisible?: boolean;
  computerPanelOpen: boolean;
  conversationId: string | undefined;
  agentId: string | undefined;
  shellWidth: number;
  railWidth: number;
  /** A phone-width viewport: only the chat (or the computer, once opened) is on screen. */
  narrow?: boolean;
  shellRef: RefObject<HTMLDivElement | null>;
}): ShellTracks {
  const {
    sidebarCollapsed,
    sidebarVisible = true,
    computerPanelOpen,
    conversationId,
    agentId,
    shellWidth,
    railWidth,
    narrow = false,
    shellRef,
  } = params;

  /** True only while a collapse/expand toggle is in flight — scopes the width animation. */
  const [animating, setAnimating] = useState(false);
  const animationTimer = useRef<number | null>(null);
  /** The user's chat-list width in px (240-400); the grid holds it while the window resizes. */
  const sidebarSize = useUiStore((state) => state.sidebarSize);
  /** Preferred computer width, independent of the current viewport. */
  const computerPaneSize = useUiStore((state) => state.computerPaneSize);

  const railByComputer = computerPanelOpen && Boolean(conversationId);
  const [autoRail, setAutoRail] = useState(
    () => railByComputer && !useUiStore.getState().sidebarCollapsed,
  );
  /** Mirrors `autoRail` for the callbacks, which run outside React's render. */
  const autoRailRef = useRef(autoRail);
  /** The persisted preference as of the last render, to tell a manual toggle from our own writes. */
  const prefBefore = useRef(sidebarCollapsed);

  const effectiveCollapsed = sidebarCollapsed || autoRail;
  const showComputer = computerPanelOpen && Boolean(agentId) && Boolean(conversationId);

  /**
   * Displayed tracks lag one frame behind toggles (motion fix, UF6): a CSS transition
   * only runs when the value changes while armed, but the old effect armed the flag
   * after the commit had already painted the target columns — so every toggle slammed
   * in a single frame. Now the toggle render arms the transition on the old tracks
   * and the next animation frame retargets them, so the ease actually runs. The
   * sidebar's collapsed rendering follows the same lagging value, so content and
   * tracks stay coordinated; drags bypass this and write sizes straight through.
   */
  const [displayed, setDisplayed] = useState(() => ({
    collapsed: effectiveCollapsed,
    computer: showComputer,
  }));
  const sidebarWidth = !sidebarVisible
    ? 0
    : Math.min(
        displayed.collapsed ? railWidth : sidebarSize,
        Math.max(0, shellWidth - CHAT_MIN_WIDTH),
      );
  const computerBounds = computerWidthBounds(shellWidth, sidebarWidth);
  // The shipped default grows with the window so the computer stays the primary
  // pane on ultrawide viewports; any saved custom width is used exactly.
  const preferredComputerWidth =
    computerPaneSize === COMPUTER_DEFAULT_WIDTH
      ? Math.max(COMPUTER_DEFAULT_WIDTH, Math.round((shellWidth - sidebarWidth) * 0.62))
      : computerPaneSize;
  const computerWidth = displayed.computer
    ? clampComputerWidth(preferredComputerWidth, computerBounds)
    : 0;
  const gridTemplateColumns = narrow
    ? displayed.computer
      ? "0px 0px minmax(0, 1fr)"
      : "0px minmax(0, 1fr) 0px"
    : displayed.computer
      ? `${sidebarWidth}px minmax(0, 1fr) ${computerWidth}px`
      : `${sidebarWidth}px minmax(0, 1fr) 0px`;
  /** Absolute overlay geometry for the two drag handles (8px on the boundary). */
  const sidebarSeparatorStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: sidebarWidth - 4,
    width: 8,
    zIndex: 10,
  };
  const computerSeparatorStyle: CSSProperties = {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: computerWidth - 4,
    width: 8,
    zIndex: 10,
  };

  /**
   * Flags the grid as animating for one collapse/expand (240ms, see app.css). Toggles arm
   * it through the retarget effect below; drags cancel it (see cancelAnimation) so the
   * pointer owns the tracks immediately. Reduced motion skips it entirely — tracks and
   * content then follow the toggle with no staged motion at all. The shared timer means
   * a rapid toggle restarts the window instead of clearing the flag mid-motion.
   */
  const beginAnimation = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    setAnimating(true);
    if (animationTimer.current !== null) window.clearTimeout(animationTimer.current);
    animationTimer.current = window.setTimeout(() => {
      animationTimer.current = null;
      setAnimating(false);
    }, 280);
  }, []);

  useEffect(
    () => () => {
      if (animationTimer.current !== null) window.clearTimeout(animationTimer.current);
    },
    [],
  );

  /**
   * Retargets the displayed tracks one frame after a toggle flips them (see
   * `displayed`): the toggle render arms the transition, the frame commits the
   * new tracks, and the sidebar content follows the same lagging value so rows
   * and tracks stay coordinated on one interruptible transition. Rapid toggles
   * cancel the pending frame and retarget from wherever the tracks are; initial
   * mount renders the settled tracks with no flag, so nothing moves on load.
   */
  useEffect(() => {
    if (displayed.collapsed === effectiveCollapsed && displayed.computer === showComputer) return;
    beginAnimation();
    const frame = nextFrame(() => {
      setDisplayed({ collapsed: effectiveCollapsed, computer: showComputer });
      useUiStore.getState().setDisplayedLayout({
        sidebarCollapsed: effectiveCollapsed,
        computerOpen: showComputer,
      });
    });
    return () => cancelFrame(frame);
  }, [displayed, effectiveCollapsed, showComputer, beginAnimation]);

  // Publish the layout snapshot for store readers (idempotent: same values re-set).
  useEffect(() => {
    useUiStore.getState().setDisplayedLayout({
      sidebarCollapsed: effectiveCollapsed,
      computerOpen: showComputer,
    });
  }, [effectiveCollapsed, showComputer]);

  /**
   * A drag grabs the tracks mid-flight: drop the toggle animation and hand the
   * columns straight to the pointer so resizes never rubber-band.
   */
  const cancelAnimation = useCallback(() => {
    if (animationTimer.current !== null) {
      window.clearTimeout(animationTimer.current);
      animationTimer.current = null;
    }
    setAnimating(false);
    setDisplayed((previous) => {
      if (previous.collapsed === effectiveCollapsed && previous.computer === showComputer) {
        return previous;
      }
      return { collapsed: effectiveCollapsed, computer: showComputer };
    });
    useUiStore.getState().setDisplayedLayout({
      sidebarCollapsed: effectiveCollapsed,
      computerOpen: showComputer,
    });
  }, [effectiveCollapsed, showComputer]);

  /** Fold the list while the computer is open, but only over an expanded manual preference. */
  useEffect(() => {
    if (railByComputer && !useUiStore.getState().sidebarCollapsed) {
      autoRailRef.current = true;
      setAutoRail(true);
      return;
    }
    autoRailRef.current = false;
    setAutoRail(false);
  }, [railByComputer]);

  /**
   * A manual toggle while the temporary rail is showing means "show me the list": the rail is
   * already collapsed, so drop the override and invert the toggle the store just applied, keeping
   * ⌘B and the user menu coherent with what the user sees.
   */
  useEffect(() => {
    const previous = prefBefore.current;
    prefBefore.current = sidebarCollapsed;
    if (previous === sidebarCollapsed || !autoRailRef.current) return;
    autoRailRef.current = false;
    setAutoRail(false);
    if (sidebarCollapsed) useUiStore.getState().setSidebarCollapsed(false);
  }, [sidebarCollapsed]);

  /**
   * Owner decision 2026-10-05 (chat-app pattern, like Telegram): there is no collapse button.
   * Dragging the list's edge past its 240px minimum snaps it to the avatar rail, and dragging
   * the rail out restores it; ⌘B and the user menu toggle it too. The rail layout must switch the
   * moment the drag crosses the minimum — not when it ends — or the full rows render squeezed
   * into the rail mid-drag, so the collapsed state follows the live size here.
   */
  const handleSidebarResizeBy = useCallback(
    (dx: number) => {
      cancelAnimation();
      // While the computer's temporary rail owns the column, a drag back out of the rail hands
      // control to the persisted preference; the rail itself never writes that preference.
      if (autoRailRef.current) {
        if (dx >= 8) {
          autoRailRef.current = false;
          setAutoRail(false);
        }
        return;
      }
      const state = useUiStore.getState();
      if (state.sidebarCollapsed) {
        if (dx >= 24) state.setSidebarCollapsed(false);
        return;
      }
      const next = state.sidebarSize + dx;
      if (next < SIDEBAR_MIN) {
        state.setSidebarCollapsed(true);
        return;
      }
      state.setSidebarSize(Math.min(SIDEBAR_MAX, Math.round(next)));
    },
    [cancelAnimation],
  );

  /** A drag starts at the rendered edge, even when the saved width exceeds the viewport. */
  const handleComputerResizeBy = useCallback(
    (dx: number) => {
      const renderedWidth = shellRef.current
        ?.querySelector("#computer")
        ?.getBoundingClientRect().width;
      const width = renderedWidth && renderedWidth > 0 ? renderedWidth : computerWidth;
      cancelAnimation();
      useUiStore.getState().setComputerPaneSize(
        clampComputerWidth(Math.round(width - dx), computerBounds),
      );
    },
    [cancelAnimation, computerWidth, computerBounds, shellRef],
  );

  /** Double-click the sidebar separator to toggle the chat list. */
  const handleSidebarSeparatorDoubleClick = useCallback(() => {
    useUiStore.getState().toggleSidebar();
  }, []);

  return {
    effectiveCollapsed,
    showComputer,
    displayedCollapsed: displayed.collapsed,
    displayedComputer: displayed.computer,
    animating,
    sidebarWidth,
    computerWidth,
    computerBounds,
    gridTemplateColumns,
    sidebarSeparatorStyle,
    computerSeparatorStyle,
    handleSidebarResizeBy,
    handleComputerResizeBy,
    handleSidebarSeparatorDoubleClick,
  };
}
