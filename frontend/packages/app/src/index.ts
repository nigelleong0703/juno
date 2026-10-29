// @agent-desktop/app — the shared React application (ARCHITECTURE §3/§4).
// Rendered by packages/web (browser) and packages/desktop (Electron) with a different client + platform.

export { AccountGate, type AccountGateProps, type GateAppProps } from "./components/AccountGate";
export { AuthContext, useAuthIdentity, useCurrentUser, usePeople, type AccountUser, type AuthIdentity } from "./auth/AuthContext";
export { App, type AppProps } from "./App";
// The platform contract (E2): the desktop preload implements these types, so they are public.
export * from "./platform";

// Data layer
export * from "./data";

// Reusable pieces
export { AccountScene } from "./components/auth/AccountScene";
export { OnboardingView, onboardingFinish, SCREEN_TITLE, type OnboardingFinish } from "./components/onboarding/Onboarding";
export { ConnectServer, type ConnectServerProps } from "./components/ConnectServer";
export * from "./components/agent";
export * from "./components/run";
export * from "./components/request";
export * from "./components/routine";
export * from "./components/conversation";
export * from "./components/computer";
export * from "./templates";
export * from "./shell";
// Features (explicit: `templates` also exports a generic `SettingsPage`, so the app's settings
// page is exported under its own name).
export {
  ComingSoon,
  type ComingSoonProps,
  NotFoundPage,
  ChatPage,
  ChatIndexPage,
  AgentRedirectPage,
  ComposeConversation,
  useStartConversation,
  type StartConversationInput,
  NewAgentTemplateDialog,
  type NewAgentTemplateDialogProps,
  useCreateAgentAndOpen,
  AgentSettingsPage,
  SettingsPage as AppSettingsPage,
  AutomationsPage,
  RoutineDetailPage,
  MemoriesPage,
  SkillsPage,
  AppsPage,
  AppDetailPage,
  LibraryPage,
  RulesPage,
  UsagePage,
} from "./features";

// Libs
export * from "./lib/status";
export * from "./lib/plannedFeatures";
export * from "./lib/format";
export * from "./lib/people";
export * from "./lib/settingsStore";
export { dragRegion, noDragRegion } from "./lib/drag";
export { DragStrip } from "./components/DragStrip";
export { t, setLocale, type Locale, type MessageKey } from "./lib/i18n";
export { useUiStore, useSidebarSections, type UiPrefs } from "./store/ui";
