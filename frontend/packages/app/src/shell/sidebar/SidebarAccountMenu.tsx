import { DropdownMenu, DropdownMenuTrigger } from "@agent-desktop/ui";
import type { ReactNode } from "react";
import { AccountMenu, type AccountMenuEntry } from "../../components/agent/AccountMenu";
import { t } from "../../lib/i18n";
import type { AccountMenuModel } from "./accountMenuEntries";

export interface SidebarAccountMenuProps {
  /** The row the menu hangs off; Radix forwards its props onto this element. */
  children: ReactNode;
  /** The signed-in user, rendered at the menu's top. */
  user: { name: string; initials: string; email?: string };
  menu: AccountMenuModel;
  theme: string;
  themePersisted: boolean;
  onThemeChange: (value: string) => void;
  signOut: AccountMenuEntry | undefined;
}

/**
 * The account menu for either trigger: the chat list's profile row and the desktop rail's
 * avatar. One layout, one entry list — the handlers stay owned by `useAccountMenu`.
 */
export function SidebarAccountMenu({
  children,
  user,
  menu,
  theme,
  themePersisted,
  onThemeChange,
  signOut,
}: SidebarAccountMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <AccountMenu
        user={user}
        primary={menu.primary}
        themeLabel={t("userMenu.theme")}
        theme={theme}
        themeDisabled={!themePersisted}
        themeOptions={menu.themeOptions}
        onThemeChange={onThemeChange}
        signOut={signOut}
      />
    </DropdownMenu>
  );
}
