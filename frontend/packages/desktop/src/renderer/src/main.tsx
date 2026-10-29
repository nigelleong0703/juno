import type { Agent, Conversation, Request } from "@agent-desktop/client";
import { hashForDeepLink, hashForRequest } from "./deep-link";
import {
  App,
  AccountGate,
  DragStrip,
  ConnectServer,
  OnboardingView,
  onboardingFinish,
  markOnboardingSeen,
  shouldShowOnboarding,
  getServerSettings,
  hasSavedServerSettings,
  setServerSettings,
  type ServerSettings,
} from "@agent-desktop/app";
import type { QueryClient } from "@tanstack/react-query";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { RendererReady, StartupBoundary } from "./StartupBoundary";
import { DesktopShell } from "./shell/DesktopShell";
import type { DesktopActionEvent } from "./env";

/**
 * Electron renderer entry (E2). Renders the very same `<App>` the web build renders, with the HTTP
 * client and the real `window.platform` from the preload. `DesktopBridge` keeps the main process
 * in sync (tray, dock badge, notifications) and turns main-process actions into routes.
 *
 * E3: on a blank install (no saved server) the shell shows the shared `<ConnectServer>` page
 * first; connecting saves the URL. The shared AccountGate registers its CSP origin and validates
 * authentication before mounting App or the notification bridge.
 */

/**
 * The app root. A blank install has no saved server: it shows the onboarding once, then the connect page. `null` server settings
 * mean "nothing configured yet" — `getServerSettings()` returns the localhost defaults whether or not anything is stored,
 * so this keys off `hasSavedServerSettings()`.
 */
function DesktopRoot() {
  const [onboarding, setOnboarding] = useState(() => shouldShowOnboarding());
  const [settings, setSettings] = useState<ServerSettings | null>(() =>
    hasSavedServerSettings() ? getServerSettings() : null,
  );

  if (onboarding) {
    return (
      <>
        <DragStrip />
        <OnboardingView
          finish={onboardingFinish(true, () => {
            markOnboardingSeen();
            setOnboarding(false);
          })}
        />
      </>
    );
  }

  if (!settings) {
    return (
      <>
        <DragStrip />
        <ConnectServer
          authMode="discover"
          onConnect={(next) => {
            setServerSettings(next);
            setSettings(next);
          }}
        />
      </>
    );
  }

  return <AccountGate settings={settings} platform={window.platform} theme="dark" onChangeServer={() => setSettings(null)} renderApp={(props) => (
    <DesktopShell>
      <App {...props} />
      <DesktopBridge queryClient={props.queryClient} />
    </DesktopShell>
  )} />;
}

/** Route a main-process action (tray / notification click, deep link) into the hash router. */
function navigateFromAction(event: DesktopActionEvent): void {
  if (event.type === "open-request") {
    window.location.hash = hashForRequest(event.conversationId);
    return;
  }
  if (event.type === "deep-link" && event.url) {
    window.location.hash = hashForDeepLink(event.url);
  }
}

/**
 * Mirrors pending approvals to the main process and subscribes to its actions. It reads the same
 * `queryClient` the app uses (passed as a prop to `<App>`), so it needs no React context.
 */
function DesktopBridge({ queryClient }: { queryClient: QueryClient }) {
  useEffect(() => {
    const push = () => {
      const lists = queryClient.getQueriesData<Request[]>({ queryKey: ["requests"] });
      const agents = queryClient
        .getQueriesData<Agent[]>({ queryKey: ["agents"] })
        .flatMap(([, data]) => data ?? []);
      const byId = new Map<string, Request>();
      for (const [, data] of lists) {
        for (const request of data ?? []) {
          if (request.status === "pending") byId.set(request.id, request);
        }
      }
      // A muted conversation keeps its pending count but gets no native notification (same rule as
      // the in-app toasts, NotificationBridge); main reads `muted` to skip it.
      const mutedIds = new Set(
        queryClient
          .getQueriesData<Conversation[]>({ queryKey: ["conversations"] })
          .flatMap(([, data]) => (Array.isArray(data) ? data : []))
          .filter((conversation) => conversation.muted)
          .map((conversation) => conversation.id),
      );
      const items = [...byId.values()].map((request) => {
        const agentName = agents.find((agent) => agent.id === request.agentId)?.name;
        return {
          id: request.id,
          title: request.title,
          ...(agentName ? { agentName } : {}),
          ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          ...(request.conversationId && mutedIds.has(request.conversationId) ? { muted: true } : {}),
        };
      });
      window.desktop?.setPending(items);
    };

    push();
    const unsubscribe = queryClient.getQueryCache().subscribe(push);
    return () => { unsubscribe(); window.desktop?.setPending([]); };
  }, [queryClient]);

  useEffect(() => window.desktop?.onAction(navigateFromAction), []);

  return null;
}

const container = document.getElementById("root");
if (!container) throw new Error("Root element #root not found");

createRoot(container).render(
  <StrictMode>
    <StartupBoundary>
      <RendererReady />
      <DesktopRoot />
    </StartupBoundary>
  </StrictMode>,
);
