import { CommandMenu, type CommandMenuGroup, useTheme } from "@agent-desktop/ui";
import {
  Blocks,
  Brain,
  CalendarDays,
  Library,
  Lightbulb,
  Monitor,
  Moon,
  Newspaper,
  PanelLeft,
  Plus,
  ScrollText,
  Settings,
  Sun,
  Target,
  Wrench,
  Workflow,
} from "lucide-react";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { AgentAvatar } from "../components/agent/AgentAvatar";
import { StackedAvatars } from "../components/agent/StackedAvatars";
import { useAgents, useConversations } from "../data/queries";
import { t } from "../lib/i18n";
import { useUiStore } from "../store/ui";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Creates a blank agent and opens it. */
  onNewAgent: () => void;
}

/**
 * ⌘K palette (ARCHITECTURE §3). A single searchable surface over chats, secondary pages and
 * global actions, built on the ui `CommandMenu` (cmdk) so filtering, keyboard nav and grouping
 * are the design system's, not ours. There is no Home/Inbox/Tasks entry (修订 v0.3); Today is the landing page.
 */
export function CommandPalette({ open, onOpenChange, onNewAgent }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { data: conversations } = useConversations();
  const { data: agents } = useAgents();
  const { theme, setTheme } = useTheme();
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const toggleComputerPanel = useUiStore((state) => state.toggleComputerPanel);

  const groups = useMemo<CommandMenuGroup[]>(() => {
    const run = (fn: () => void) => () => {
      fn();
      onOpenChange(false);
    };

    const agentById = new Map((agents ?? []).map((agent) => [agent.id, agent]));

    const chatItems = (conversations ?? [])
      .filter((conversation) => conversation.kind !== "task")
      // Empty query: the palette opens on the most recent chats, as the sidebar search used to.
      .sort((a, b) => new Date(b.lastItemAt).getTime() - new Date(a.lastItemAt).getTime())
      .map((conversation) => {
        const members = conversation.agentIds.flatMap((id) => {
          const agent = agentById.get(id);
          return agent ? [agent] : [];
        });
        const primary = members[0];
        const isGroup = conversation.kind === "room" || conversation.kind === "peer";
        const fallback = isGroup
          ? members.map((member) => member.name).join(", ") || undefined
          : primary?.name;
        const name = conversation.title ?? fallback ?? t("chat.untitled");
        return {
          id: `chat-${conversation.id}`,
          label: name,
          keywords: [...members.flatMap((member) => [member.handle, member.title, member.name]), conversation.kind],
          icon: members.length > 1 ? (
            <StackedAvatars agents={members} slot={16} label={name} />
          ) : primary ? (
            <AgentAvatar agentId={primary.id} avatar={primary.avatar} status={primary.status} size={16} />
          ) : (
            <Monitor className="size-4" />
          ),
          onSelect: run(() => navigate(`/c/${conversation.id}`)),
        };
      });

    const pageItems = [
      { id: "page-today", label: t("nav.today"), icon: <CalendarDays className="size-4" />, to: "/" },
      { id: "page-settings", label: t("nav.settings"), icon: <Settings className="size-4" />, to: "/settings/models" },
      { id: "page-feed", label: t("nav.feed"), icon: <Newspaper className="size-4" />, to: "/feed" },
      { id: "page-ideas", label: t("nav.ideas"), icon: <Lightbulb className="size-4" />, to: "/ideas" },
      { id: "page-goals", label: t("nav.goals"), icon: <Target className="size-4" />, to: "/goals" },
      { id: "page-automations", label: t("nav.automations"), icon: <Workflow className="size-4" />, to: "/automations" },
      { id: "page-skills", label: t("nav.skills"), icon: <Wrench className="size-4" />, to: "/skills" },
      { id: "page-apps", label: t("nav.apps"), icon: <Blocks className="size-4" />, to: "/apps" },
      { id: "page-memories", label: t("nav.memories"), icon: <Brain className="size-4" />, to: "/memories" },
      { id: "page-library", label: t("nav.library"), icon: <Library className="size-4" />, to: "/library" },
      { id: "page-rules", label: t("nav.rules"), icon: <ScrollText className="size-4" />, to: "/rules" },
      { id: "page-usage", label: t("nav.usage"), icon: <Monitor className="size-4" />, to: "/usage" },
    ].map((page) => ({
      id: page.id,
      label: page.label,
      keywords: ["go", "open", "page"],
      icon: page.icon,
      onSelect: run(() => navigate(page.to)),
    }));

    const actionItems = [
      {
        id: "action-new-agent",
        label: t("palette.action.newAgent"),
        icon: <Plus className="size-4" />,
        onSelect: run(() => onNewAgent()),
      },
      {
        id: "action-toggle-computer",
        label: t("palette.action.toggleComputer"),
        icon: <Monitor className="size-4" />,
        onSelect: run(() => toggleComputerPanel()),
      },
      {
        id: "action-toggle-theme",
        label: t("palette.action.toggleTheme"),
        icon: theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />,
        onSelect: run(() => setTheme(theme === "dark" ? "light" : "dark")),
      },
      {
        id: "action-toggle-sidebar",
        label: t("palette.action.toggleSidebar"),
        icon: <PanelLeft className="size-4" />,
        onSelect: run(() => toggleSidebar()),
      },
    ];

    return [
      { heading: t("palette.chats"), items: chatItems },
      { heading: t("palette.pages"), items: pageItems },
      { heading: t("palette.actions"), items: actionItems },
    ];
  }, [
    agents,
    conversations,
    theme,
    setTheme,
    navigate,
    onOpenChange,
    onNewAgent,
    toggleSidebar,
    toggleComputerPanel,
  ]);

  return (
    <CommandMenu
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      placeholder={t("palette.placeholder")}
      emptyMessage={t("palette.empty")}
    />
  );
}
