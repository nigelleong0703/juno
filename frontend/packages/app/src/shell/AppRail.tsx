import { cn } from "@agent-desktop/ui";
import { useLocation, useNavigate } from "react-router";
import { useCurrentUser } from "../auth/AuthContext";
import { AccountAvatar } from "../components/agent/AccountAvatar";
import { useNeedsYouRequests } from "../data/queries";
import { t } from "../lib/i18n";
import { REFERENCE_RAIL_WIDTH_PX } from "../lib/windowChrome";
import { SidebarAccountMenu } from "./sidebar/SidebarAccountMenu";
import { NAV, isNavActive } from "./sidebar/SidebarNav";
import { useAccountMenu } from "./sidebar/useAccountMenu";

/**
 * The app's icon rail (owner reference 2026-10-17, Codex form): the app's destinations at the
 * top, the signed-in account at the bottom. 52px wide against the 44px top bar — the measured
 * reference — and it lives inside the app's providers so it can read the pending count and the
 * account menu.
 *
 * It is the shell's ONE navigation tree: the chat list carries the search field, the filter
 * chips and the chats, never a second copy of the destinations. Both builds render it — the
 * browser build included, so the two shells are the same structure (owner request 2026-10-20).
 * A phone-width viewport has no room for it: the destinations move into the menu sheet.
 */
export function AppRail() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: pending } = useNeedsYouRequests();
  const currentUser = useCurrentUser();
  const { menu, theme, themePersisted, onThemeChange, signOut } = useAccountMenu();

  const badges: Partial<Record<(typeof NAV)[number]["key"], number>> = {
    today: pending?.length ?? 0,
  };

  return (
    <nav
      data-slot="app-rail"
      aria-label={t("nav.destinations")}
      style={{ width: REFERENCE_RAIL_WIDTH_PX }}
      className="flex shrink-0 flex-col items-center gap-1 bg-sidebar pb-2 pt-2"
    >
      {NAV.map(({ key, to, label, icon: Icon }, index) => {
        const active = isNavActive(key, to, pathname);
        const badge = badges[key] ?? 0;
        // The icon button's accessible name is the destination itself; the shortcut
        // rides in the tooltip, so a screen reader hears "Toolbox", not "Toolbox ⌘6".
        const name = t(label);
        const shortcut = `${name}  ⌘${index + 1}`;
        return (
          <button
            key={key}
            type="button"
            title={shortcut}
            aria-label={name}
            data-slot="app-rail-item"
            data-active={active ? "true" : undefined}
            onClick={() => navigate(to)}
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors focus-ring",
              active
                ? "bg-sidebar-accent text-fg"
                : "text-fg-muted hover:bg-sidebar-accent/60 hover:text-fg",
            )}
          >
            <span className="relative flex size-[18px] items-center justify-center">
              <Icon className="size-[18px]" aria-hidden />
              {badge > 0 && (
                <span className="pointer-events-none absolute -right-2 -top-1.5 min-w-4 rounded-full bg-info px-1 text-center text-[10px] font-semibold leading-4 text-white">
                  {badge}
                </span>
              )}
            </span>
          </button>
        );
      })}

      {/* The signed-in account sits at the rail's bottom, as in the reference. */}
      <div className="mt-auto flex flex-col items-center">
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
            className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-sidebar-accent/60 focus-ring"
          >
            <AccountAvatar initials={currentUser.initials} />
          </button>
        </SidebarAccountMenu>
      </div>
    </nav>
  );
}
