import { cn } from "@agent-desktop/ui";
import { Plus, Settings } from "lucide-react";
import { AccountAvatar } from "../../components/agent/AccountAvatar";
import type { AccountMenuEntry } from "../../components/agent/AccountMenu";
import { t } from "../../lib/i18n";
import { ROW_RADIUS } from "./SidebarWidgets";
import { SidebarAccountMenu } from "./SidebarAccountMenu";
import type { AccountMenuModel } from "./accountMenuEntries";

export interface SidebarFooterProps {
  collapsed: boolean;
  onCompose: boolean;
  currentUser: { name: string; initials: string };
  menu: AccountMenuModel;
  theme: string;
  themePersisted: boolean;
  onThemeChange: (value: string) => void;
  signOut: AccountMenuEntry | undefined;
  onOpenNew: () => void;
  /**
   * The account row. The app's icon rail carries the signed-in account in every
   * build, so the list does not repeat it — except in the phone menu sheet, where
   * the rail is not on screen and the sheet is the only place to sign out.
   */
  showAccount?: boolean;
}

/**
 * Footer: new-chat above the bottom-anchored profile row. It stays mounted in
 * both states and rides the shared collapse/fade clock — open on the rail,
 * folded away (inert) when expanded. The profile row itself never changes
 * layout: full width, avatar slot steady, name fading in place.
 */
export function SidebarFooter({
  collapsed,
  onCompose,
  currentUser,
  menu,
  theme,
  themePersisted,
  onThemeChange,
  signOut,
  onOpenNew,
  showAccount = false,
}: SidebarFooterProps) {
  return (
    <div
      data-slot="sidebar-footer"
      className="flex min-w-0 shrink-0 flex-col px-2 pb-2 pt-1"
    >
      <div
        data-slot="sidebar-newchat"
        className="collapse-rows shrink-0"
        data-closed={!collapsed ? "true" : undefined}
      >
        <div inert={!collapsed || undefined} aria-hidden={!collapsed || undefined}>
          <div className="flex flex-col items-center pb-1">
            <button
              type="button"
              onClick={onOpenNew}
              aria-label={t("sidebar.newChat")}
              title={t("sidebar.newChat")}
              tabIndex={collapsed ? undefined : -1}
              className="group flex size-11 items-center justify-center rounded-full bg-transparent focus-ring"
            >
              <span
                className={cn(
                  "flex size-[40px] items-center justify-center text-fg-subtle transition-colors group-hover:text-fg",
                  ROW_RADIUS,
                  onCompose
                    ? "bg-sidebar-accent"
                    : "group-hover:bg-sidebar-accent/60",
                )}
              >
                <Plus className="size-[18px]" />
              </span>
            </button>
          </div>
        </div>
      </div>
      {showAccount ? (
        <SidebarAccountMenu
          user={currentUser}
          menu={menu}
          theme={theme}
          themePersisted={themePersisted}
          onThemeChange={onThemeChange}
          signOut={signOut}
        >
            <button
              type="button"
              aria-label={currentUser.name}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 overflow-hidden px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent/60 focus-ring",
                ROW_RADIUS,
              )}
            >
              <span className="sidebar-footer-avatar flex size-10 shrink-0 items-center justify-center">
                <AccountAvatar initials={currentUser.initials} />
              </span>
              <span
                aria-hidden={collapsed || undefined}
                className={cn(
                  "sidebar-fade flex min-w-0 flex-1 items-center gap-2 overflow-hidden",
                  collapsed && "pointer-events-none opacity-0",
                )}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {currentUser.name}
                </span>
                <Settings className="size-4 shrink-0 text-fg-subtle" />
              </span>
            </button>
        </SidebarAccountMenu>
      ) : null}
    </div>
  );
}
