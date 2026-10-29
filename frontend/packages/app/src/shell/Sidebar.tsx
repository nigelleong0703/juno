import {
  SearchField,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  cn,
  toast,
} from "@agent-desktop/ui";
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useMatch, useNavigate } from "react-router";
import { usePlatform } from "../data/ClientProvider";
import {
  useDeleteConversation,
  useMarkConversationRead,
  useUpdateAgent,
  useUpdateConversation,
} from "../data/mutations";
import { useAgents, useConversations, useNeedsYouRequests } from "../data/queries";
import { resolveShellRailWidth } from "../lib/windowChrome";
import { t } from "../lib/i18n";
import { useCurrentUser } from "../auth/AuthContext";
import { useUiStore } from "../store/ui";
import { useAccountMenu } from "./sidebar/useAccountMenu";
import { buildAgentIndex, buildChatEntries, primaryAgentFor } from "./sidebar/chatEntries";
import type { ChatEntry } from "./sidebar/chatEntries";
import { SidebarFooter } from "./sidebar/SidebarFooter";
import { SidebarList } from "./sidebar/SidebarList";
import { SidebarNav } from "./sidebar/SidebarNav";
import { RenameDialog } from "./sidebar/SidebarWidgets";

export interface SidebarProps {
  /**
   * Legacy animation flag, ignored for geometry. Layout follows the collapsed
   * state alone with one interruptible CSS transition; kept for caller compat.
   */
  animating?: boolean;
  /**
   * The shell's effective collapsed state. Opening the computer folds the list to its rail as a
   * temporary layout mode, so this can differ from the persisted preference the store holds; when
   * given, the rail follows it and the store keeps the user's saved choice untouched.
   */
  collapsedOverride?: boolean;
  className?: string;
  /**
   * The phone menu sheet, where there is no room for the icon rail: the destinations
   * are listed at the top of the sheet instead. The desktop and browser builds get
   * them from the rail, so they pass false.
   */
  showNavigation?: boolean;
}

/**
 * The chat list (ARCHITECTURE 修订 v0.3; owner feedback 2026-10-05): the left column IS the chat
 * list: no Inbox/Tasks nav, no workspace header. (Home is gone: "/" is the Today page, reached from the user menu.) The sidebar surface
 * reaches the top of the window; its first row is the shared-header-height drag region and holds
 * only the new-agent "+" and the collapse button, right-aligned. The user menu at the bottom is the only place user identity appears.
 */
export function Sidebar({
  collapsedOverride,
  className,
  showNavigation = false,
}: SidebarProps) {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const match = useMatch("/c/:conversationId");
  const activeId = match?.params.conversationId;
  const onCompose = Boolean(useMatch("/new"));

  const { data: conversations } = useConversations();
  const { data: agents } = useAgents();
  const { data: pending } = useNeedsYouRequests();
  const markRead = useMarkConversationRead();
  const updateAgent = useUpdateAgent();
  const updateConversation = useUpdateConversation();
  const deleteConversation = useDeleteConversation();

  const storedCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const collapsed = collapsedOverride ?? storedCollapsed;
  // Saved expanded width: the Recents chrome sizes its fading content to it, so
  // the wrapping chips never reflow while the rail narrows under them.
  const sidebarSize = useUiStore((state) => state.sidebarSize);
  const composeRecipients = useUiStore((state) => state.composeRecipients);
  const account = useAccountMenu();
  const saveFailed = account.saveFailed;
  const themeFailedShown = useRef(false);
  useEffect(() => {
    if (saveFailed && !themeFailedShown.current) {
      themeFailedShown.current = true;
      toast.error(t("common.error"));
    }
    if (!saveFailed) themeFailedShown.current = false;
  }, [saveFailed]);

  const platform = usePlatform();
  const hasTrafficLights = platform.hasTrafficLights;
  const railWidth = resolveShellRailWidth(hasTrafficLights);
  /**
   * The chat list sits beside the app's icon rail, so it is a panel inset from it —
   * rounded where it meets the rail (12px, measured on the reference). The phone
   * menu sheet has no rail beside it, so there is nothing to round against.
   */
  const inset = !showNavigation;

  const [renameTarget, setRenameTarget] = useState<ChatEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatEntry | null>(null);

  const agentById = useMemo(() => buildAgentIndex(agents), [agents]);
  const [search, setSearch] = useState("");
  const entries = useMemo(
    () => buildChatEntries(conversations, agentById, search, t("chat.untitled")),
    [conversations, agentById, search],
  );

  const open = (conversationId: string) => {
    markRead.mutate(conversationId);
    navigate(`/c/${conversationId}`);
  };

  /**
   * Owner feedback (UF6): the needs-you count is its own button - it opens the
   * conversation AND the agent's computer instead of just selecting the chat.
   */
  const openComputer = (conversationId: string) => {
    markRead.mutate(conversationId);
    navigate(`/c/${conversationId}`);
    useUiStore.getState().setComputerPanelOpen(true);
  };

  const openNew = () => navigate("/new");
  const togglePin = ({ conversation }: ChatEntry) =>
    updateConversation.mutate({ id: conversation.id, patch: { pinned: !conversation.pinned } });
  const toggleMute = ({ conversation }: ChatEntry) =>
    updateConversation.mutate({ id: conversation.id, patch: { muted: !conversation.muted } });

  // Stable collapse: one header, one nav tree, one list and one footer stay mounted.
  // Collapsing fades text in place on the shared 240ms panel clock while icons drift
  // to centre; the Recents chrome folds its own height and the footer new-chat opens.
  // The inner column always fills the live track width.

  const headerControls = (
    <>
      {/* The inline field filters the chats as you type (as before); ⌘K still opens the palette.
          Collapsed, search and new-chat shrink to zero width and fade in place behind
          inert + aria-hidden, leaving only the toggle centred — the row keeps its
          height either way, so the nav below never moves on y. */}
      <div
        inert={collapsed || undefined}
        aria-hidden={collapsed || undefined}
        className={cn(
          // Clip horizontally only: the collapse animation needs w-0 to hide the field, but clipping
          // vertically cut the search pill's focus ring in half.
          "sidebar-fade min-w-0 flex-1 overflow-x-clip",
          collapsed && "pointer-events-none w-0 flex-none opacity-0",
        )}
      >
        <SearchField
          className="w-full"
          // 32px like the new-chat button beside it, so 32 + the row's 6px padding fills the 38px
          // row exactly; the md size (36px) overflowed it and the row's overflow-hidden clipped the pill.
          size="sm"
          value={search}
          onValueChange={setSearch}
          placeholder={t("sidebar.searchPlaceholder")}
        />
      </div>
      <button
        type="button"
        onClick={openNew}
        aria-label={t("sidebar.newChat")}
        aria-hidden={collapsed || undefined}
        inert={collapsed || undefined}
        tabIndex={collapsed ? -1 : undefined}
        title={`${t("sidebar.newChat")}  ⌘N`}
        className={cn(
          "sidebar-fade flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-fg transition-colors",
          onCompose ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
          "focus-ring",
          collapsed && "pointer-events-none w-0 p-0 opacity-0",
        )}
      >
        <Plus className="size-[18px] shrink-0" />
      </button>
    </>
  );

  return (
    <aside
      data-slot="sidebar"
      className={cn(
        "h-full min-h-0 overflow-hidden border-r border-fg/10 bg-bg",
        // The list is a panel inset from the icon rail, rounded where it meets it
        // (measured 12px on the reference, top and bottom).
        inset && "rounded-l-[12px]",
        className,
      )}
    >
      <div
        data-slot="sidebar-inner"
        data-collapsed={collapsed ? "true" : undefined}
        data-rail={railWidth}
        className="flex h-full min-h-0 flex-col"
        style={{ width: "100%", "--sidebar-chrome-width": `${Math.max(sidebarSize - 32, 0)}px` } as CSSProperties}
      >
        {/* Single stable header: fixed heights in both states, so no row below ever
            changes y. Expanded it holds search and new-chat; collapsed only the
            centred toggle while the rest shrink away in place. */}
        <div
          data-slot="sidebar-header"
          className={cn(
            "min-w-0 shrink-0",
            // The list's first row sits ~10px below the shell's top row instead of
            // hugging it (owner reference 2026-10-17).
            // Expanded only: on the rail the first avatar lines up with the icon rail's
            // first icon, so the breathing room would read as an empty band.
            !collapsed && "pt-2.5",
          )}
        >
          {/* Folded, not just faded: the search row must not leave an empty band above the
              avatars when the list collapses to its rail. */}
          <div
            data-slot="sidebar-search-row"
            className="collapse-rows shrink-0"
            data-closed={collapsed ? "true" : undefined}
          >
            <div inert={collapsed || undefined} aria-hidden={collapsed || undefined}>
              <div className="relative flex h-[38px] min-w-0 items-center gap-1 pl-2 pr-2 pb-1.5">
                {headerControls}
              </div>
            </div>
          </div>
          {showNavigation ? (
            <SidebarNav collapsed={collapsed} badges={{ today: pending?.length ?? 0 }} />
          ) : null}
        </div>

        <SidebarList
          entries={entries}
          activeId={activeId}
          collapsed={collapsed}
          composeRecipients={composeRecipients}
          agentById={agentById}
          onCompose={onCompose}
          onOpen={open}
          onOpenComputer={openComputer}
          onTogglePin={togglePin}
          onMarkRead={({ conversation }) => markRead.mutate(conversation.id)}
          onProfile={(agent) => navigate(`/agents/${agent.id}/settings`)}
          onRenameEntry={setRenameTarget}
          onDeleteEntry={setDeleteTarget}
          onMute={toggleMute}
          onOpenDraft={openNew}
        />

        <SidebarFooter
          collapsed={collapsed}
          onCompose={onCompose}
          currentUser={currentUser}
          menu={account.menu}
          theme={account.theme}
          themePersisted={account.themePersisted}
          onThemeChange={account.onThemeChange}
          signOut={account.signOut}
          onOpenNew={openNew}
          // The phone sheet has no icon rail, so it is the only place to sign out.
          showAccount={showNavigation}
        />
      </div>

      <RenameDialog
        entry={renameTarget}
        pending={updateAgent.isPending}
        onClose={() => setRenameTarget(null)}
        onSubmit={(name) => {
          const agent = renameTarget ? primaryAgentFor(renameTarget) : undefined;
          if (agent) updateAgent.mutate({ id: agent.id, patch: { name } });
          setRenameTarget(null);
        }}
      />

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chatList.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("chatList.deleteBody", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTarget) deleteConversation.mutate(deleteTarget.conversation.id);
                setDeleteTarget(null);
              }}
            >
              {t("chatList.deleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
