import type { ApiClient, EventSource } from "@agent-desktop/client";
import { ThemeProvider, Toaster, TooltipProvider, useTheme, type Theme } from "@agent-desktop/ui";
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { Navigate, RouterProvider, createHashRouter, useLocation, useParams } from "react-router";
import { ModelGate } from "./components/ModelGate";
import { ClientProvider, useLiveSync } from "./data";
import { usePlatform } from "./data/ClientProvider";
import { AgentPane } from "./features/agents/pane/AgentPane";
import { PlannedFeaturesProvider, type PlannedFeatures } from "./lib/plannedFeatures";
import { webPlatform, type PlatformAdapter } from "./platform";
import { AppShell } from "./shell/AppShell";
import {
  AgentRedirectPage,
  AgentSettingsPage,
  AppDetailPage,
  AppsPage,
  ChatIndexPage,
  ChatPage,
  ComposeConversation,
  DiscoverPage,
  FeedPage,
  GoalsPage,
  IdeasPage,
  LibraryPage,
  MemoriesPage,
  NotFoundPage,
  RoutineDetailPage,
  AutomationsPage,
  RulesPage,
  SettingsPage,
  SkillsPage,
  TeamPage,
  ToolboxLayout,
  UsagePage,
} from "./features";

export interface AppProps {
  /** The API client. When it also implements `EventSource` the live sync is wired automatically. */
  client: ApiClient & Partial<EventSource>;
  /** Platform capabilities; defaults to the browser adapter. */
  platform?: PlatformAdapter;
  /** Optional pre-built QueryClient (tests inject their own). */
  queryClient?: QueryClient;
  /** Theme used when the user has no stored preference. */
  theme?: Theme;
  /** Prototype-only fallbacks (MUSE-PARITY step 7); production passes nothing. See `lib/plannedFeatures`. */
  planned?: PlannedFeatures;
}

/**
 * The route table (ARCHITECTURE §11, 修订 v0.3). The shell is the chat app itself: the left
 * column is the chat list. `/` is Today (agents, what needs you, the day's brief), `/new`
 * is the unsent "new message" draft, and task threads live under their
 * conversation. Every other page is secondary, reached from the user menu or ⌘K. A hash router
 * keeps the app portable inside Electron.
 */
/**
 * The sign-in page returns to `/plugins?tab=connectors&status=…` (the OAuth return URL is a server setting): land on the Apps
 * page with the status, or on Skills for `?tab=skills`.
 */
function PluginsReturn() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  if (params.get("tab") === "skills") return <Navigate to="/skills" replace />;
  params.delete("tab");
  const query = params.toString();
  return <Navigate to={`/apps${query ? `?${query}` : ""}`} replace />;
}

/** Old `/routines/:id` address, kept for bookmarks. */
function RedirectRoutine() {
  const { id } = useParams();
  return <Navigate to={`/automations/${id ?? ""}`} replace />;
}

const router = createHashRouter([
  {
    path: "/",
    element: <ShellRoute />,
    children: [
      // Today (the home tab) and the Chat tab share one entry; see ChatIndexPage.
      { index: true, element: <ChatIndexPage view="today" /> },
      { path: "chat", element: <ChatIndexPage view="chat" /> },
      { path: "new", element: <ComposeConversation /> },
      { path: "c/:conversationId", element: <ChatPage /> },
      // An agent's page is its conversation (owner feedback 2026-10-05).
      { path: "agents/:agentId", element: <AgentRedirectPage /> },
      { path: "agents/:agentId/settings/:section?", element: <AgentSettingsPage /> },
      { path: "team/:segment?", element: <TeamPage /> },
      { path: "team/:segment/:id", element: <TeamPage /> },
      { path: "discover", element: <DiscoverPage /> },
      { path: "goals/:id?", element: <GoalsPage /> },
      { path: "feed/:postId?", element: <FeedPage /> },
      { path: "ideas", element: <IdeasPage /> },
      { path: "toolbox", element: <Navigate to="/automations" replace /> },
      {
        element: <ToolboxLayout />,
        children: [
          { path: "automations", element: <AutomationsPage /> },
          { path: "automations/:id", element: <RoutineDetailPage /> },
          { path: "rules", element: <RulesPage /> },
          { path: "memories", element: <MemoriesPage /> },
          { path: "usage", element: <UsagePage /> },
        ],
      },
      { path: "routines", element: <Navigate to="/automations" replace /> },
      { path: "routines/:id", element: <RedirectRoutine /> },
      { path: "apps", element: <AppsPage /> },
      { path: "apps/:appId", element: <AppDetailPage /> },
      { path: "skills", element: <SkillsPage /> },
      // The server's OAuth return address (a deployment setting) still says `plugins?tab=connectors&status=…`.
      { path: "plugins", element: <PluginsReturn /> },
      { path: "connectors", element: <PluginsReturn /> },
      { path: "library/:fileId?", element: <LibraryPage /> },
      { path: "settings/:section?", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

/**
 * Explicit sign-in/up resets to the index so it opens the account's home. Restored sessions never call this, so deep-links
 * survive a reload.
 */
export function resetAppSessionNavigation() {
  void router.navigate("/", { replace: true });
}

/** Opens a conversation, replacing the index entry (first-run landing after sign-up). */
export function openAppConversation(id: string) {
  void router.navigate(`/c/${id}`, { replace: true });
}

function isEventSource(client: unknown): client is EventSource {
  if (typeof client !== "object" || client === null || !("subscribe" in client)) return false;
  return typeof client.subscribe === "function";
}

/** Mounts the event→cache reducer inside the query client. */
function LiveSync() {
  useLiveSync();
  return null;
}

/**
 * Keeps the native window's appearance in step with the app theme. Native materials
 * (macOS vibrancy) follow the OS appearance by default, which washes the chrome out
 * whenever the app theme and the system disagree.
 */
function NativeAppearance() {
  const platform = usePlatform();
  const { theme } = useTheme();
  useEffect(() => {
    platform.setAppearance?.(theme);
  }, [platform, theme]);
  return null;
}

/**
 * The shell route — where the app composes the shell's injected slots.
 * As the route element it sits inside both the router context and the
 * client/query providers.
 */
function ShellRoute() {
  return (
    <AppShell
      renderPane={(agentId, conversationId) => <AgentPane agentId={agentId} conversationId={conversationId} />}
    />
  );
}

/**
 * The whole application: theme, toasts, tooltips, the client/platform injection points and the
 * router. `packages/web` and `packages/desktop` both render exactly this, differing only in the client
 * and the platform adapter they pass (ARCHITECTURE §3/§9).
 */
export function App({ client, platform = webPlatform, queryClient, theme = "dark", planned }: AppProps) {
  const events = isEventSource(client) ? client : null;

  return (
    <ThemeProvider defaultTheme={theme}>
      <TooltipProvider delayDuration={300}>
        <ClientProvider
          client={client}
          events={events}
          platform={platform}
          queryClient={queryClient}
        >
          <LiveSync />
          <NativeAppearance />
          <PlannedFeaturesProvider value={planned ?? null}>
            <ModelGate><RouterProvider router={router} /></ModelGate>
          </PlannedFeaturesProvider>
          <Toaster />
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
