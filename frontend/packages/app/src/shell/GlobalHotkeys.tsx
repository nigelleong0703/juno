import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useUiStore } from "../store/ui";
import { NAV } from "./sidebar/SidebarNav";

export interface GlobalHotkeysProps {
  /** Open (or toggle) the ⌘K palette. */
  onOpenPalette: () => void;
  /** Create a blank agent and open it (⌘N). */
  onNewAgent: () => void;
}

/** True for ⌘ on macOS and Ctrl elsewhere — the two are treated interchangeably. */
function isCommand(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

/** Don't hijack shortcuts while the user is typing in a field or the palette. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * App-wide keyboard shortcuts (ARCHITECTURE §3): ⌘K palette, ⌘\ right pane, ⌘B chat list,
 * ⌘N new agent, ⌘1–⌘6 the sidebar's destinations (Chat, Feed, Ideas, Goals, Library, Toolbox). Registered once at the shell level so they work from every screen.
 */
export function GlobalHotkeys({ onOpenPalette, onNewAgent }: GlobalHotkeysProps) {
  const navigate = useNavigate();
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const toggleComputerPanel = useUiStore((state) => state.toggleComputerPanel);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isCommand(event)) return;

      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenPalette();
        return;
      }

      // ⌘1–⌘5 work from anywhere, like ⌘K: a digit types nothing useful into a field.
      const destination = /^[1-9]$/.test(event.key) ? NAV[Number(event.key) - 1] : undefined;
      if (destination) {
        event.preventDefault();
        navigate(destination.to);
        return;
      }

      if (event.key === "\\") {
        event.preventDefault();
        toggleComputerPanel();
        return;
      }

      // ⌘B shows/hides the chat list from anywhere, including while typing (the composer is
      // plain text, so there is no bold to clash with).
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
        return;
      }

      if (isTypingTarget(event.target)) return;

      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        onNewAgent();
        return;
      }

      if (event.key === ",") {
        event.preventDefault();
        navigate("/settings/models");
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, onNewAgent, onOpenPalette, toggleComputerPanel, toggleSidebar]);

  return null;
}
