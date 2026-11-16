import { Outlet, useLocation } from "react-router";
import { SettingsShell } from "../settings/SettingsShell";

/** The Workspace pages of Settings (Routines, Rules, Memory, Usage): the settings list beside the page. */
const ACTIVE_BY_PREFIX = [
  ["/automations", "routines"],
  ["/rules", "rules"],
  ["/memories", "memory"],
  ["/usage", "usage"],
] as const;

export function ToolboxLayout() {
  const { pathname } = useLocation();
  const active = ACTIVE_BY_PREFIX.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1];
  return (
    <SettingsShell bare activeId={active}>
      <Outlet />
    </SettingsShell>
  );
}
