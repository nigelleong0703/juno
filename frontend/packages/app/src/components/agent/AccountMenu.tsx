import type { ReactNode } from "react";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@agent-desktop/ui";
import { SunMoon } from "lucide-react";
import { AccountAvatar } from "./AccountAvatar";

/**
 * Compact account menu (owner feedback 2026-10-06: the sidebar user menu is too large).
 * The 12-entry flat list becomes compact primary entries with the theme switcher and the
 * secondary destinations tucked into submenu groups; the sidebar toggle sits above
 * a separated Sign out entry at the very bottom. Settings leads the primary list. Every action arrives via props so the owner (Sidebar footer) keeps its
 * real handlers — this component only lays them out. Keyboard/focus behavior comes from the
 * Radix primitives (roving focus, arrow-key radio group, Escape, focus return to trigger);
 * the content keeps the shared popover tokens with a compact width, and the ui primitive
 * already caps height to the viewport with scrolling.
 */
export interface AccountMenuEntry {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** Unsupported destinations stay visible but disabled instead of dead links. */
  disabled?: boolean;
  /** A count shown at the row's right edge when above zero. */
  badge?: number;
}

export interface AccountMenuThemeOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface AccountMenuProps {
  /** The signed-in user, shown at the menu's top like the reference app. */
  user: { name: string; initials: string; email?: string };
  /** Compact top-level entries, starting with Settings. */
  primary: AccountMenuEntry[];
  themeLabel: string;
  theme: string;
  themeOptions: AccountMenuThemeOption[];
  onThemeChange: (value: string) => void;
  /** Disable theme selection until the persisted source is ready. */
  themeDisabled?: boolean;
  /** Sign-out stays last, separated from everything above. */
  signOut?: AccountMenuEntry;
}

export function AccountMenu({
  user,
  primary,
  themeLabel,
  theme,
  themeOptions,
  onThemeChange,
  themeDisabled = false,
  signOut,
}: AccountMenuProps) {
  return (
    <DropdownMenuContent data-slot="account-menu" align="start" side="top" className="w-52">
      <div data-slot="account-menu-header" className="flex min-w-0 items-center gap-2.5 px-2 py-1.5">
        <AccountAvatar initials={user.initials} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{user.name}</p>
          {user.email ? <p className="truncate text-xs text-fg-muted">{user.email}</p> : null}
        </div>
      </div>
      <DropdownMenuSeparator />
      {primary.map((entry) => (
        <DropdownMenuItem key={entry.key} onSelect={entry.onSelect} disabled={entry.disabled}>
          {entry.icon}
          {entry.label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <SunMoon className="size-4" />
          {themeLabel}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}>
            {themeOptions.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value} disabled={themeDisabled}>
                {option.icon}
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {signOut === undefined ? null : (
        <>
          {/* One separator ahead of Sign out: the sidebar toggle used to own the first one. */}
          <DropdownMenuSeparator />
          <DropdownMenuItem key={signOut.key} onSelect={signOut.onSelect} disabled={signOut.disabled}>
            {signOut.icon}
            {signOut.label}
          </DropdownMenuItem>
        </>
      )}
    </DropdownMenuContent>
  );
}
