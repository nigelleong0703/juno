import { Button, cn } from "@agent-desktop/ui";
import { X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ComputerPane, RoutinesPanel } from "../components/computer";
import { tc } from "../components/computer/i18n";
import { PILL } from "../components/computer/surface";
import { ConversationFilesPanel } from "../components/chat-files";
import { dragRegion, noDragRegion } from "../lib/drag";
import { useUiStore } from "../store/ui";

/**
 * The right-hand column of the shell (ARCHITECTURE 修订 v0.3). This file is the seam between the
 * shell and the computer feature: E1 passes `{ agentId, conversationId, className }`. The slot
 * hosts neutral Computer / Chat files / Routines tabs in the pane header; Chat files embeds
 * the scoped `ConversationFilesPanel` and Routines the conversation-scoped `RoutinesPanel`, while the
 * live `ComputerPane` stays mounted hidden so screen state survives.
 *
 * No separator line is drawn here — the pane sits on the panel tone and separates by colour. The
 * resize handle and its styling belong to the shell (E1), so any className it passes wins.
 */
export interface ComputerPaneSlotProps {
  agentId: string;
  conversationId: string;
  className?: string;
  /**
   * Replaces the whole pane with the agent pane (MUSE-PARITY step 7). Injected by the composition
   * root because shell must not import features; `App` always passes it, so the built-in tabs
   * below are only the shell's default when no composition root supplies a pane.
   */
  renderPane?: (agentId: string, conversationId: string) => ReactNode;
}

export function ComputerPaneSlot({ agentId, conversationId, className, renderPane }: ComputerPaneSlotProps) {
  if (renderPane) return <div key={conversationId} className={cn("h-full min-h-0", className)}>{renderPane(agentId, conversationId)}</div>;
  return <SlotBody key={conversationId} agentId={agentId} conversationId={conversationId} className={className} />;
}

type PaneTab = "computer" | "files" | "routines";

function PaneTabs({
  tab,
  onChange,
}: {
  tab: PaneTab;
  onChange: (tab: PaneTab, viaKeyboard: boolean) => void;
}) {
  const order: PaneTab[] = ["computer", "files", "routines"];
  const labels: Record<PaneTab, string> = {
    computer: tc("computer.tab.computer"),
    files: "Chat files",
    routines: tc("computer.tab.routines"),
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const at = order.indexOf(tab);
    const delta = event.key === "ArrowRight" ? 1 : order.length - 1;
    const next = order[(at + delta) % order.length];
    if (next === undefined || next === tab) return;
    event.preventDefault();
    // Focus follows in the slot effect: this event fires in the outgoing tablist, which
    // unmounts or hides right after the switch, so focusing here would lose focus.
    onChange(next, true);
  };
  return (
    <div role="tablist" aria-label={tc("computer.header.title")} onKeyDown={onKeyDown} className="flex items-center gap-1">
      {order.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          tabIndex={tab === id ? 0 : -1}
          onClick={() => {
            onChange(id, false);
          }}
          className={cn(
            "rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring",
            tab === id
              ? "bg-interactive-selected text-fg"
              : "text-fg-muted hover:bg-interactive-hover hover:text-fg active:bg-interactive-pressed",
          )}
        >
          {labels[id]}
        </button>
      ))}
    </div>
  );
}

function SlotBody({ agentId, conversationId, className }: ComputerPaneSlotProps) {
  const [tab, setTab] = useState<PaneTab>("computer");
  const setComputerPanelOpen = useUiStore((state) => state.setComputerPanelOpen);
  const computerRef = useRef<HTMLDivElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const routinesRef = useRef<HTMLDivElement>(null);
  // Arrow-key navigation must land focus on the newly visible tab: the key event fires in
  // the outgoing tablist (hidden right after the switch), so focus follows in an effect.
  // Mouse clicks keep native focus on the clicked button.
  const keyboardNavRef = useRef(false);
  const handleChange = (next: PaneTab, viaKeyboard: boolean) => {
    if (next === tab) return;
    keyboardNavRef.current = viaKeyboard;
    setTab(next);
  };
  // Layout timing: the runtime asserts activeElement synchronously after the arrow key, so
  // the visible selected tab takes focus before paint, never on mouse clicks.
  useLayoutEffect(() => {
    if (!keyboardNavRef.current) return;
    keyboardNavRef.current = false;
    const host =
      tab === "computer" ? computerRef.current : tab === "files" ? filesRef.current : routinesRef.current;
    const selected = host?.querySelector('[role="tab"][aria-selected="true"]');
    if (selected instanceof HTMLElement) selected.focus();
  }, [tab]);
  const tabs = <PaneTabs tab={tab} onChange={handleChange} />;
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-panel", className)}>
      <div ref={computerRef} className={cn("min-h-0 flex-1 flex-col", tab === "computer" ? "flex" : "hidden")}>
        <ComputerPane agentId={agentId} conversationId={conversationId} headerTabs={tabs} />
      </div>
      {tab === "files" ? (
        <div ref={filesRef} className="flex min-h-0 flex-1 flex-col">
          <div
            style={dragRegion}
            data-slot="computer-header"
            className="flex h-[var(--shell-header-height)] shrink-0 select-none items-center gap-2 px-3"
          >
            <span className="flex min-w-0 flex-1 items-center">
              <span style={noDragRegion} className="flex items-center">
                {tabs}
              </span>
            </span>
            <div style={noDragRegion} className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className={PILL}
                aria-label={tc("computer.action.close")}
                onClick={() => setComputerPanelOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1">
            <ConversationFilesPanel conversationId={conversationId} />
          </div>
        </div>
      ) : null}
      {tab === "routines" ? (
        <div ref={routinesRef} className="flex min-h-0 flex-1 flex-col">
          <div
            style={dragRegion}
            data-slot="computer-header"
            className="flex h-[var(--shell-header-height)] shrink-0 select-none items-center gap-2 px-3"
          >
            <span className="flex min-w-0 flex-1 items-center">
              <span style={noDragRegion} className="flex items-center">
                {tabs}
              </span>
            </span>
            <div style={noDragRegion} className="flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon-sm"
                className={PILL}
                aria-label={tc("computer.action.close")}
                onClick={() => setComputerPanelOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RoutinesPanel agentId={agentId} conversationId={conversationId} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
