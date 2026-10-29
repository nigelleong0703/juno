import { BriefcaseBusiness, Blocks, Monitor, Moon, Settings, Sparkles, Sun } from "lucide-react";
import type {
  AccountMenuEntry,
  AccountMenuThemeOption,
} from "../../components/agent/AccountMenu";
import { t } from "../../lib/i18n";

export interface AccountMenuModel {
  primary: AccountMenuEntry[];
  themeOptions: AccountMenuThemeOption[];
}

/**
 * The compact account menu (owner reference 2026-10-17): Settings, the theme switcher and
 * sign-out. Toolbox and Plugins left the tab bar on 2026-10-26 (five tabs), so they live here too.
 */
export function buildAccountMenuModel(params: {
  navigate: (path: string) => void;
}): AccountMenuModel {
  const { navigate } = params;
  return {
    primary: [
      {
        key: "settings",
        label: t("nav.settings"),
        icon: <Settings className="size-4" />,
        onSelect: () => navigate("/settings/models"),
      },
      {
        key: "toolbox",
        label: t("nav.toolbox"),
        icon: <BriefcaseBusiness className="size-4" />,
        onSelect: () => navigate("/toolbox"),
      },
      {
        key: "apps",
        label: t("nav.apps"),
        icon: <Blocks className="size-4" />,
        onSelect: () => navigate("/apps"),
      },
      {
        key: "skills",
        label: t("nav.skills"),
        icon: <Sparkles className="size-4" />,
        onSelect: () => navigate("/skills"),
      },
    ],
    themeOptions: [
      { value: "dark", label: t("userMenu.theme.dark"), icon: <Moon className="size-4" /> },
      { value: "light", label: t("userMenu.theme.light"), icon: <Sun className="size-4" /> },
      { value: "system", label: t("userMenu.theme.system"), icon: <Monitor className="size-4" /> },
    ],
  };
}

