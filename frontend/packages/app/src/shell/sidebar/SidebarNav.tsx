import { cn } from "@agent-desktop/ui";
import { Compass, Folder, MessageCircle, Sun, Users } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { t } from "../../lib/i18n";

/**
 * The five destinations, in order (owner-approved 2026-10-26): Today · Chat · Team · Discover · Library. They replace
 * Chat · Feed · Ideas · Goals · Library; Feed and Ideas now live under Today, Goals under Team, and Toolbox and
 * Plugins sit in the account menu.
 */
export const NAV = [
  { key: "today", to: "/", label: "nav.today", icon: Sun },
  { key: "chat", to: "/chat", label: "nav.chat", icon: MessageCircle },
  { key: "team", to: "/team", label: "nav.team", icon: Users },
  { key: "discover", to: "/discover", label: "nav.discover", icon: Compass },
  { key: "library", to: "/library", label: "nav.library", icon: Folder },
] as const;

/** Route match for one destination, shared with the desktop icon rail. Full pages reached from a tab keep that tab lit. */
export function isNavActive(key: (typeof NAV)[number]["key"], to: string, pathname: string): boolean {
  if (key === "today") return pathname === "/" || pathname === "/feed" || pathname.startsWith("/feed/") || pathname === "/ideas";
  if (key === "chat") return pathname === "/chat" || pathname === "/new" || pathname.startsWith("/c/");
  if (key === "team") return pathname === "/team" || pathname.startsWith("/team/") || pathname === "/goals" || pathname.startsWith("/goals/");
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Today shows what needs you (the iPhone tab badge); the other tabs carry no count. */
export function SidebarNav({
  badges,
  collapsed = false,
}: {
  badges: Partial<Record<(typeof NAV)[number]["key"], number>>;
  /** Collapsed rail: labels fade and hide from assistive tech, buttons stay put. */
  collapsed?: boolean;
}) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // One tree for the list and the rail: same mounted buttons, same h-8 rows and
  // y positions in both states. The label column fades/clips in place while the
  // icon drifts to centre on the shared panel clock. The count rides on the icon
  // wrapper as a corner badge in both states, so it never clips mid-motion.
  return (
    <nav aria-label={t("nav.destinations")} data-slot="sidebar-nav" className="flex min-w-0 flex-col gap-0.5 overflow-hidden px-2 pb-1.5">
      {NAV.map(({ key, to, label, icon: Icon }, index) => {
        const active = isNavActive(key, to, pathname);
        const badge = badges[key] ?? 0;
        const name = `${t(label)}  ⌘${index + 1}`;
        return (
          <button
            key={key}
            type="button"
            onClick={() => navigate(to)}
            title={name}
            aria-label={collapsed ? name : undefined}
            data-active={active ? "true" : undefined}
            className={cn(
              "flex h-8 w-full min-w-0 items-center gap-2.5 overflow-hidden rounded-full px-3 text-left text-sm transition-colors focus-ring",
              active ? "bg-sidebar-accent font-medium text-fg" : "text-fg-muted hover:bg-sidebar-accent/60",
            )}
          >
            <span className="sidebar-nav-icon relative flex size-[18px] shrink-0 items-center justify-center">
              <Icon className="size-[18px]" aria-hidden />
              {badge > 0 && (
                <span
                  data-testid={`nav-badge-${key}`}
                  className="pointer-events-none absolute -right-2 -top-1.5 min-w-4 rounded-full bg-info px-1 text-center text-[10px] font-semibold leading-4 text-white"
                >
                  {badge}
                </span>
              )}
            </span>
            <span
              aria-hidden={collapsed || undefined}
              className={cn(
                "sidebar-fade min-w-0 flex-1 truncate",
                collapsed && "pointer-events-none opacity-0",
              )}
            >
              {t(label)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between px-2 pt-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{title}</h3>
      {action}
    </div>
  );
}
