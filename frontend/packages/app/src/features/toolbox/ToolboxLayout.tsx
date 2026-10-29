import { Outlet, useLocation, useNavigate } from "react-router";
import { SettingsPage } from "../../templates/SettingsPage";
import { buildToolboxGroups } from "./toolboxEntries";

/**
 * Toolbox (owner request 2026-10-17, as a sidebar page 2026-10-21): the tools that used to live behind
 * the account menu's More submenu are sections of one page. The section nav is the page's own sidebar
 * (the top-left toggle shows and hides it); each section keeps its own header and body.
 */
export function ToolboxLayout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const entries = buildToolboxGroups().flatMap((group) => group.entries);
  const active = entries.find((entry) => pathname === entry.to || pathname.startsWith(`${entry.to}/`));

  return (
    <SettingsPage
      bare
      activeId={active?.key}
      onSelect={(key) => {
        const entry = entries.find((item) => item.key === key);
        if (entry) navigate(entry.to);
      }}
      sections={entries.map((entry) => ({ id: entry.key, label: entry.label, icon: <entry.icon className="size-4" /> }))}
    >
      <Outlet />
    </SettingsPage>
  );
}
