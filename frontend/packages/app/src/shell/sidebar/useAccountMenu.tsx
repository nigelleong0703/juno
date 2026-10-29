import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import { LogOut } from "lucide-react";
import type { AccountMenuEntry } from "../../components/agent/AccountMenu";
import { useAuthIdentity } from "../../auth/AuthContext";
import { usePersistedTheme } from "../../lib/persistedTheme";
import { buildAccountMenuModel, type AccountMenuModel } from "./accountMenuEntries";

export interface AccountMenuState {
  menu: AccountMenuModel;
  theme: string;
  themePersisted: boolean;
  /** True when the server rejected the last theme write; the caller may toast it. */
  saveFailed: boolean;
  onThemeChange: (value: string) => void;
  signOut: AccountMenuEntry | undefined;
}

/**
 * The account menu's live handlers, shared by the sidebar footer and the desktop icon rail:
 * one model, one theme choice, one sign-out, no second wiring.
 */
export function useAccountMenu(): AccountMenuState {
  const navigate = useNavigate();
  const identity = useAuthIdentity();
  const { theme, setPersistedTheme, persisted, saveFailed } = usePersistedTheme();

  const menu = useMemo(
    () => buildAccountMenuModel({ navigate }),
    [navigate],
  );
  const onThemeChange = useCallback(
    (value: string) => {
      if (value === "dark" || value === "light" || value === "system") setPersistedTheme(value);
    },
    [setPersistedTheme],
  );
  const signOut =
    identity?.mode === "account"
      ? {
          key: "sign-out",
          label: "Sign out",
          icon: <LogOut className="size-4" />,
          onSelect: identity.signOut,
        }
      : undefined;

  return { menu, theme, themePersisted: persisted, saveFailed, onThemeChange, signOut };
}
