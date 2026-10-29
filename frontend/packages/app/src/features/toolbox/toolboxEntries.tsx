import { Brain, Monitor, ScrollText, Workflow, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";

export interface ToolboxEntry {
  key: string;
  label: string;
  description: string;
  to: string;
  icon: LucideIcon;
}

export interface ToolboxGroup {
  key: string;
  label: string;
  entries: ToolboxEntry[];
}

/**
 * The Toolbox page's rows (owner request 2026-10-17): the destinations that used to hide in the
 * account menu's More submenu, grouped the way that submenu grouped them.
 */
export function buildToolboxGroups(): ToolboxGroup[] {
  const automations: ToolboxEntry = {
    key: "routines",
    label: t("nav.automations"),
    description: t("toolbox.automations.description"),
    to: "/automations",
    icon: Workflow,
  };
  const rules: ToolboxEntry = {
    key: "rules",
    label: t("nav.rules"),
    description: t("toolbox.rules.description"),
    to: "/rules",
    icon: ScrollText,
  };
  const memories: ToolboxEntry = {
    key: "memories",
    label: t("nav.memories"),
    description: t("toolbox.memories.description"),
    to: "/memories",
    icon: Brain,
  };
  const usage: ToolboxEntry = {
    key: "usage",
    label: t("nav.usage"),
    description: t("toolbox.usage.description"),
    to: "/usage",
    icon: Monitor,
  };

  return [
    { key: "automate", label: t("toolbox.group.automate"), entries: [automations, rules] },
    { key: "knowledge", label: t("toolbox.group.knowledge"), entries: [memories] },
    { key: "system", label: t("toolbox.group.system"), entries: [usage] },
  ];
}
