import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { COMPUTER_DEFAULT_WIDTH, COMPUTER_MIN_WIDTH } from "../lib/shellLayout";

/**
 * UI-only preferences (ARCHITECTURE §8). Server data lives in TanStack Query; current
 * selection lives in the URL. Nothing here is server state.
 */
/**
 * A recipient of an unsent "new message" draft (owner feedback 2026-10-05). `agent` recipients
 * already exist; `new` recipients become a blank agent on send (the setup proposal continues).
 */
export interface ComposeRecipient {
  /** Stable local key — a "new" recipient has no agent id yet. */
  key: string;
  kind: "agent" | "new";
  agentId?: string;
  name: string;
}

/** Where the agent management dropdown is anchored: the conversation header's avatar or the workspace's name. */
export type AgentPanelAnchor = "header" | "workspace";

/** The workspace's two views. */
export type WorkspaceTab = "computer" | "files";

export interface UiPrefs {
  /** Collapses the chat list to the 84px avatar rail (VISUAL.md "Window and layout"). */
  sidebarCollapsed: boolean;
  /** The model gate is showing: a full-window first-run screen, so the desktop shell hides its top row. Not persisted. */
  modelGateOpen: boolean;
  setModelGateOpen: (open: boolean) => void;
  /** The user's chat-list width in px (owner feedback 2026-10-05: sizes are pixels, 240–400). */
  sidebarSize: number;
  /** Preferred right-pane width; viewport constraints never overwrite this intent. */
  computerPaneSize: number;
  sidebarCompact: boolean;
  /** Right pane (the agent's computer) visibility; open by default (修订 v0.3). */
  computerPanelOpen: boolean;
  compactMode: boolean;
  theme: "dark" | "light" | "system";
  /** The unsent recipients of the "new message" draft (draft row at the top of the chat list). */
  composeRecipients: ComposeRecipient[];
  /**
   * Derived layout — NOT persisted. Persisted prefs above are user intent; these mirror
   * what the shell actually displays, written only by AppShell's animation loop. Readers
   * (e.g. the chat header toggle) follow these once synced, so pressed states track the
   * effective pane instead of a stale pref.
   */
  /** Whether the shell has published its first layout snapshot this mount. */
  layoutSynced: boolean;
  /** Displayed chat-list state (lags toggles by one frame while animating). */
  displayedSidebarCollapsed: boolean;
  /** Displayed computer-pane state (lags toggles by one frame while animating). */
  displayedComputerOpen: boolean;
  setDisplayedLayout: (layout: { sidebarCollapsed: boolean; computerOpen: boolean }) => void;
  /** Not persisted: text to put in a chat's composer when it next opens (accepting an idea). */
  composerPrefill: { conversationId: string; text: string } | null;
  /**
   * Not persisted: which anchor has the agent management dropdown open (null = closed), and the
   * workspace's tab and group agent (null = the conversation's own agent).
   */
  agentPanelAnchor: AgentPanelAnchor | null;
  workspaceTab: WorkspaceTab;
  workspaceAgentId: string | null;
  setAgentPanelAnchor: (anchor: AgentPanelAnchor | null) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setWorkspaceAgent: (agentId: string | null) => void;
  /** Opens the right pane on the workspace (for one agent in a group chat). */
  openWorkspace: (agentId?: string | null) => void;
  setComposerPrefill: (prefill: { conversationId: string; text: string } | null) => void;
  /** Not persisted: an inspiration starter's text, waiting for the agent the user is about to create. */
  starterText: string | null;
  setStarterText: (text: string | null) => void;
  setSidebarCollapsed: (value: boolean) => void;
  toggleSidebar: () => void;
  setSidebarSize: (value: number) => void;
  setComputerPaneSize: (value: number) => void;
  setSidebarCompact: (value: boolean) => void;
  setComputerPanelOpen: (value: boolean) => void;
  toggleComputerPanel: () => void;
  setTheme: (theme: "dark" | "light" | "system") => void;
  addComposeRecipient: (recipient: ComposeRecipient) => void;
  removeComposeRecipient: (key: string) => void;
  clearCompose: () => void;
}

/**
 * Storage for persisted prefs. Browsers and Electron provide localStorage; contexts
 * without one (some jsdom setups) fall back to memory so renders that publish layout
 * snapshots never crash on write.
 */
function prefsStorage() {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Access itself can throw (blocked storage) — fall through to memory.
  }
  const map = new Map<string, string>();
  return {
    getItem: (name: string) => map.get(name) ?? null,
    setItem: (name: string, value: string) => {
      map.set(name, value);
    },
    removeItem: (name: string) => {
      map.delete(name);
    },
  };
}

const legacyPrefs = z.object({ computerPaneSize: z.number().finite().optional() }).passthrough();

export const useUiStore = create<UiPrefs>()(
  persist<UiPrefs, [], [], Partial<UiPrefs>>(
    (set) => ({
      sidebarCollapsed: false,
      modelGateOpen: false,
      setModelGateOpen: (open) => set({ modelGateOpen: open }),
      sidebarSize: 280,
      computerPaneSize: COMPUTER_DEFAULT_WIDTH,
      sidebarCompact: false,
      computerPanelOpen: true,
      compactMode: false,
      theme: "dark",
      composeRecipients: [],
      layoutSynced: false,
      displayedSidebarCollapsed: false,
      displayedComputerOpen: false,
      composerPrefill: null,
      agentPanelAnchor: null,
      workspaceTab: "computer",
      workspaceAgentId: null,
      setAgentPanelAnchor: (anchor) => set({ agentPanelAnchor: anchor }),
      setWorkspaceTab: (tab) => set({ workspaceTab: tab }),
      setWorkspaceAgent: (agentId) => set({ workspaceAgentId: agentId }),
      openWorkspace: (agentId = null) => set({ computerPanelOpen: true, workspaceAgentId: agentId }),
      setComposerPrefill: (prefill) => set({ composerPrefill: prefill }),
      starterText: null,
      setStarterText: (text) => set({ starterText: text }),
      setDisplayedLayout: (layout) =>
        set({
          layoutSynced: true,
          displayedSidebarCollapsed: layout.sidebarCollapsed,
          displayedComputerOpen: layout.computerOpen,
        }),
      setSidebarCollapsed: (value) => set({ sidebarCollapsed: value }),
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarSize: (value) => set({ sidebarSize: value }),
      setComputerPaneSize: (value) => set({ computerPaneSize: value }),
      setSidebarCompact: (value) => set({ sidebarCompact: value }),
      setComputerPanelOpen: (value) => set({ computerPanelOpen: value }),
      toggleComputerPanel: () =>
        set((state) => ({ computerPanelOpen: !state.computerPanelOpen })),
      setTheme: (theme) => set({ theme }),
      addComposeRecipient: (recipient) =>
        set((state) => ({
          composeRecipients: state.composeRecipients.some((r) => r.key === recipient.key)
            ? state.composeRecipients
            : [...state.composeRecipients, recipient],
        })),
      removeComposeRecipient: (key) =>
        set((state) => ({
          composeRecipients: state.composeRecipients.filter((r) => r.key !== key),
        })),
      clearCompose: () => set({ composeRecipients: [] }),
    }),
    {
      name: "agent-desktop-ui-prefs",
      version: 3,
      migrate: (persisted, version) => {
        const parsed = legacyPrefs.safeParse(persisted);
        if (!parsed.success) return {};
        const width = parsed.data.computerPaneSize;
        // Upgrade each version's shipped default, not other saved user widths.
        const previousDefault =
          (version === 0 && width === 380) ||
          (version === 1 && width === 560) ||
          (version === 2 && width === 680);
        const computerPaneSize = width === undefined || previousDefault
          ? COMPUTER_DEFAULT_WIDTH
          : Math.max(COMPUTER_MIN_WIDTH, width ?? COMPUTER_DEFAULT_WIDTH);
        return { ...parsed.data, computerPaneSize };
      },
      storage: createJSONStorage(() => prefsStorage()),
      // Only user intent persists; the derived layout above is per-mount transient.
      partialize: (state) => ({
        sidebarCollapsed: state.sidebarCollapsed,
        sidebarSize: state.sidebarSize,
        computerPaneSize: state.computerPaneSize,
        sidebarCompact: state.sidebarCompact,
        computerPanelOpen: state.computerPanelOpen,
        compactMode: state.compactMode,
        theme: state.theme,
        composeRecipients: state.composeRecipients,
      }),
    },
  ),
);

/** Collapsible sidebar sections (Personal / Work / …), remembered across sessions. */
interface SidebarState {
  collapsedSections: Record<string, boolean>;
  toggleSection: (name: string) => void;
}

export const useSidebarSections = create<SidebarState>()(
  persist(
    (set) => ({
      collapsedSections: {},
      toggleSection: (name) =>
        set((state) => ({
          collapsedSections: {
            ...state.collapsedSections,
            [name]: !state.collapsedSections[name],
          },
        })),
    }),
    { name: "agent-desktop-sidebar-sections" },
  ),
);
