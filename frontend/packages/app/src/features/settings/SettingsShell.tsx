import { cn } from "@agent-desktop/ui";
import {
  BellRing,
  Brain,
  ChevronRight,
  Contact,
  Cpu,
  Gauge,
  Info,
  Laptop,
  Palette,
  Plug,
  RefreshCw,
  ShieldCheck,
  UserRound,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useAuthIdentity } from "../../auth/AuthContext";
import { t } from "../../lib/i18n";
import { SettingsPage } from "../../templates/SettingsPage";
import { PauseOutgoing } from "./PauseOutgoing";


interface Page {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Where it opens when it is not a section of /settings. */
  to?: string;
  group?: string;
}

/**
 * The Settings list in the iPhone's order (More page): account, About you, Your details, interruptions, the
 * pause switch, Models, the Workspace pages, then what only a computer has. The Workspace pages keep their
 * own routes; everything else is `/settings/:id`.
 */
const PAGES: Page[] = [
  { id: "profile", label: t("settings.profile"), icon: UserRound },
  { id: "details", label: t("settings.details"), icon: Contact },
  { id: "proactive", label: t("settings.proactive"), icon: BellRing },
  { id: "models", label: t("settings.models"), icon: Cpu, group: t("settings.group.models") },
  { id: "routines", label: t("settings.routines"), icon: RefreshCw, to: "/automations", group: t("settings.workspace") },
  { id: "rules", label: t("nav.rules"), icon: ShieldCheck, to: "/rules", group: t("settings.workspace") },
  { id: "memory", label: t("settings.memory"), icon: Brain, to: "/memories", group: t("settings.workspace") },
  { id: "usage", label: t("nav.usage"), icon: BarChart3, to: "/usage", group: t("settings.workspace") },
  { id: "appearance", label: t("settings.appearance"), icon: Palette, group: t("settings.group.device") },
  { id: "mac", label: t("settings.myMac"), icon: Laptop, group: t("settings.group.device") },
  { id: "connection", label: t("settings.connection"), icon: Plug, group: t("settings.group.device") },
  { id: "budget", label: t("settings.budgets"), icon: Gauge, group: t("settings.group.device") },
  { id: "about", label: t("settings.about"), icon: Info, group: t("settings.group.device") },
];

export function settingsPageLabel(id: string): string {
  return PAGES.find((page) => page.id === id)?.label ?? "";
}

export function isSettingsPage(id: string | undefined): boolean {
  return PAGES.some((page) => page.id === id && page.to === undefined);
}

function Card({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section aria-label={title} className="space-y-1 pb-2">
      <h2 className="px-2 pb-1 pt-3 text-xs font-medium text-fg-muted">{title}</h2>
      {children}
    </section>
  );
}


function AccountRows() {
  const identity = useAuthIdentity();
  if (!identity) return null;
  return (
    <div className="px-2 text-sm">
      <div className="flex items-baseline justify-between gap-3 py-1">
        <span className="truncate text-fg">{identity.user.name}</span>
        <span className="truncate text-xs text-fg-subtle">{identity.user.email}</span>
      </div>
      {identity.mode === "account" && (
        <button type="button" onClick={identity.signOut} className="rounded-md py-1 text-danger focus-ring hover:underline">
          {t("settings.signOut")}
        </button>
      )}
    </div>
  );
}

/** Agents are reached from the sidebar's "Your agents"; Settings is about the person and the workspace. */
function NavHeader() {
  return (
    <div className="hidden md:block">
      <Card title={t("settings.group.account")}>
        <AccountRows />
      </Card>
    </div>
  );
}

/**
 * The shared frame of Settings and the Workspace pages (Routines, Rules, Memory, Usage): the iPhone's
 * settings list on the left, the selected page on the right.
 */
export function SettingsShell({ activeId, bare, children }: { activeId: string | undefined; bare?: boolean; children: ReactNode }) {
  const navigate = useNavigate();
  const sections = PAGES.map((page) => ({
    id: page.id,
    label: page.label,
    icon: <page.icon className="size-4" />,
    ...(page.group === undefined ? {} : { group: page.group }),
    ...(page.to === undefined ? {} : { trailing: <ChevronRight className={cn("size-4 text-fg-subtle")} /> }),
  }));
  // The pause switch sits between the interruptions page and the Models group, as on the phone.
  const withPause = [
    ...sections.slice(0, 3),
    { id: "pause", label: t("delivery.pause.title"), block: <div className="hidden pt-2 md:block"><PauseOutgoing /></div> },
    ...sections.slice(3),
  ];
  return (
    <SettingsPage
      wide
      {...(bare ? { bare } : {})}
      navHeader={<NavHeader />}
      activeId={activeId}
      sections={withPause}
      onSelect={(id) => {
        const page = PAGES.find((entry) => entry.id === id);
        navigate(page?.to ?? `/settings/${id}`);
      }}
    >
      {children}
    </SettingsPage>
  );
}
