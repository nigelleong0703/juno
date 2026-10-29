export { ComingSoon, type ComingSoonProps } from "./ComingSoon";
export { NotFoundPage } from "./NotFoundPage";

// Chat (修订 v0.3): the shell's centre column — one conversation per route.
export { ChatPage } from "./chat/ChatPage";
export { ChatIndexPage } from "./chat/ChatIndexPage";
export { AgentRedirectPage } from "./chat/AgentRedirectPage";

// New message draft ("+" / ⌘N) — compose, then create the agent / room on send.
export {
  ComposeConversation,
  useStartConversation,
  type StartConversationInput,
} from "./compose";

// New agent flow.
export {
  NewAgentTemplateDialog,
  type NewAgentTemplateDialogProps,
} from "./new-agent/NewAgentTemplateDialog";
export { useCreateAgentAndOpen } from "./new-agent/useCreateAgentAndOpen";

// Goals and the feed (MUSE-PARITY step 7, BACKEND §10.10).
export { GoalsPage, GoalDetailPage } from "./goals";
export { FeedPage } from "./feed";
export { IdeasPage } from "./ideas";

// Five tabs (owner-approved 2026-10-26): Team and Discover; Today is the chat index's `/` view.
export { TeamPage } from "./team";
export { DiscoverPage } from "./discover";

// Agent settings (E1).
export { AgentSettingsPage } from "./agents/AgentSettingsPage";

// Secondary pages. F owns these folders and exports one page component per folder from
// `features/<name>/index.ts`; until those land, the router resolves them through the aliases
// below (same names, same no-prop contract).
export { SettingsPage } from "./settings";
export { AutomationsPage } from "./automations";
export { RoutineDetailPage } from "./routines";
export { MemoriesPage } from "./memories";
export { SkillsPage } from "./skills";
export { AppsPage, AppDetailPage } from "./apps";
export { LibraryPage } from "./library";
export { UsagePage } from "./usage";
export { RulesPage } from "./rules";
// Toolbox: the tools hub behind the rail's Toolbox icon (owner request 2026-10-17).
export { ToolboxLayout } from "./toolbox/ToolboxLayout";
