import type { ApiClient, EventSource } from "@agent-desktop/client";
import { createHttpClient } from "@agent-desktop/client/http";
import { QueryClient } from "@tanstack/react-query";
import { Button, ThemeProvider, type Theme } from "@agent-desktop/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { App, openAppConversation, resetAppSessionNavigation, type AppProps } from "../App";
import { AuthContext, type AuthIdentity } from "../auth/AuthContext";
import {
  AuthenticationError, accountUser, discoverAuthInfo, authRequest, authResultSchema, createAccountClient,
  normalizeServerUrl, sessionSchema, sessionSecretKey, type AccountSession,
} from "../auth/account";
import { TOKEN_USER } from "../lib/people";
import type { ServerSettings } from "../lib/settingsStore";
import { createServerConnectivityResolver, webPlatform, type PlatformAdapter } from "../platform";
import { useUiStore } from "../store/ui";
import { DragStrip } from "./DragStrip";
import { AccountForm } from "./auth/AccountForm";
import { AccountScene } from "./auth/AccountScene";
import { SCREEN_TITLE } from "./onboarding/Onboarding";
import { ServerConnectionContext } from "./ServerConnection";
import { appClientKind } from "../platform/clientKind";

export interface GateAppProps extends AppProps { queryClient: QueryClient }
export interface AccountGateProps {
  settings: ServerSettings;
  platform?: PlatformAdapter;
  theme?: Theme;
  onChangeServer?: () => void;
  /** Native integration mounts its notification bridge only inside an active session. */
  renderApp?: (props: GateAppProps) => ReactNode;
  fetcher?: typeof fetch;
}
interface Ready {
  kind: "ready";
  identity: AuthIdentity;
  client: ApiClient & Partial<EventSource>;
  queryClient: QueryClient;
  dispose: () => void;
  token?: string;
  expiresAt?: number;
}
type GateState = Ready | { kind: "loading"; message: string } | { kind: "error"; message: string }
  | { kind: "form"; message?: string };

function clearDomainSelection() {
  useUiStore.setState({ composeRecipients: [] });
}
function clearReady(ready: Ready | null) {
  if (!ready) return;
  ready.dispose();
  void ready.queryClient.cancelQueries();
  ready.queryClient.clear();
}
function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: false } } });
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not connect to the authentication server.";
}

/** Changing the server unmounts the entire prior session before any new domain query can run. */
export function AccountGate(props: AccountGateProps) {
  return <ServerAccountGate key={props.settings.serverUrl} {...props} />;
}

function ServerAccountGate({
  settings, platform = webPlatform, theme = "dark", onChangeServer,
  renderApp = (props) => <App {...props} />, fetcher = globalThis.fetch,
}: AccountGateProps) {
  const [state, setState] = useState<GateState>({ kind: "loading", message: "Connecting to your server…" });
  const [retry, setRetry] = useState(0);
  const [entered, setEntered] = useState(false);
  const readyRef = useRef<Ready | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const connectivity = useMemo(() => createServerConnectivityResolver(platform), [platform]);

  // Stable so the bootstrap effect below does not re-enter auth on every render.
  const removeStoredToken = useCallback(async (serverUrl: string) => {
    if (platform.isDesktop) await platform.secrets?.delete(sessionSecretKey(serverUrl));
  }, [platform]);
  const leaveAccount = async (message: string | undefined, revoke: boolean) => {
    const ready = readyRef.current;
    if (!ready || ready.identity.mode !== "account") return;
    readyRef.current = null;
    clearReady(ready);
    clearDomainSelection();
    resetAppSessionNavigation();
    platform.setBadge(0);
    setState({ kind: "loading", message: revoke ? "Signing out…" : "Clearing your session…" });
    const signal = lifecycle.current?.signal;
    let failure: string | undefined;
    const serverUrl = normalizeServerUrl(settings.serverUrl);
    try {
      if (revoke) await authRequest(fetcher, serverUrl, "sign-out", z.unknown(), { token: ready.token, body: {}, signal });
    } catch (error) {
      failure = `Signed out on this device. Server sign-out failed: ${errorMessage(error)}`;
    } finally {
      try { await removeStoredToken(serverUrl); }
      catch (error) { failure = `Session cleared from memory, but encrypted storage cleanup failed: ${errorMessage(error)}`; }
      if (!signal?.aborted) setState({ kind: "form", message: failure ?? message });
    }
  };
  const leaveRef = useRef(leaveAccount);
  leaveRef.current = leaveAccount;

  const acceptSession = useCallback(async (session: AccountSession, serverUrl: string, signal: AbortSignal) => {
    if (signal.aborted) return;
    const expiresAt = Date.parse(session.session.expiresAt);
    if (expiresAt <= Date.now()) throw new Error("Your session has expired. Sign in again.");
    if (platform.isDesktop) {
      if (!platform.secrets) throw new Error("Encrypted session storage is unavailable. Please reopen the desktop app.");
      await platform.secrets.set(sessionSecretKey(serverUrl), session.session.token);
    }
    if (signal.aborted) return;
    clearReady(readyRef.current);
    clearDomainSelection();
    const transport = createAccountClient(serverUrl, session.session.token, fetcher, () => {
      void leaveRef.current("Your session has expired. Sign in again.", false);
    });
    const ready: Ready = {
      kind: "ready", client: transport.client, dispose: transport.dispose, queryClient: newQueryClient(),
      token: session.session.token, expiresAt,
      identity: { mode: "account", user: accountUser(session.user), signOut: () => { void leaveRef.current(undefined, true); } },
    };
    readyRef.current = ready;
    setState(ready);
  }, [platform, fetcher]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    setState({ kind: "loading", message: "Connecting to your server…" });
    void (async () => {
      try {
        const serverUrl = normalizeServerUrl(settings.serverUrl);
        const step = await connectivity(settings);
        if (controller.signal.aborted) return;
        if (step.kind === "reload") { window.location.reload(); return; }
        const info = await discoverAuthInfo(fetcher, serverUrl, settings.apiToken, controller.signal);
        if (controller.signal.aborted) return;
        if (info?.mode === "token") {
          const ready: Ready = {
            kind: "ready", queryClient: newQueryClient(), dispose: () => {},
            identity: { mode: "token", user: TOKEN_USER },
            client: createHttpClient({ baseUrl: serverUrl, getToken: () => settings.apiToken, fetch: fetcher, clientKind: appClientKind() }),
          };
          readyRef.current = ready;
          setState(ready);
          return;
        }
        if (!info?.providers.includes("credential")) throw new Error("This server does not offer email and password sign-in.");
        // A developer token is never used to authenticate an account-mode server.
        const token = platform.isDesktop ? await platform.secrets?.get(sessionSecretKey(serverUrl)) ?? undefined : undefined;
        if (controller.signal.aborted) return;
        const session = await authRequest(fetcher, serverUrl, "get-session", sessionSchema, { token, signal: controller.signal }).catch((error: unknown) => {
          if (error instanceof AuthenticationError && error.status === 401) return null;
          throw error;
        });
        if (controller.signal.aborted) return;
        if (session && Date.parse(session.session.expiresAt) > Date.now()) {
          await acceptSession(session, serverUrl, controller.signal);
          return;
        }
        await removeStoredToken(serverUrl);
        if (controller.signal.aborted) return;
        clearDomainSelection();
        resetAppSessionNavigation();
        if (!controller.signal.aborted) setState({ kind: "form", message: token || session ? "Your session has expired. Sign in again." : undefined });
      } catch (error) {
        if (!controller.signal.aborted) setState({ kind: "error", message: errorMessage(error) });
      }
    })();
    return () => {
      controller.abort();
      clearReady(readyRef.current);
      readyRef.current = null;
    };
  }, [connectivity, settings, fetcher, retry, platform, acceptSession, removeStoredToken]);

  // Session validation on focus and periodically catches revocation even without a domain request.
  const accountToken = state.kind === "ready" ? state.token : undefined;
  const expiresAt = state.kind === "ready" ? state.expiresAt : undefined;
  useEffect(() => {
    if (!accountToken || !expiresAt) return;
    const controller = new AbortController();
    let validating = false;
    let currentExpiry = expiresAt;
    let expiryTimer: ReturnType<typeof setTimeout>;
    const scheduleExpiry = () => {
      clearTimeout(expiryTimer);
      const remaining = currentExpiry - Date.now();
      expiryTimer = setTimeout(() => {
        if (currentExpiry <= Date.now()) void leaveRef.current("Your session has expired. Sign in again.", false);
        else scheduleExpiry();
      }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    };
    const validate = async () => {
      if (validating || document.visibilityState === "hidden") return;
      validating = true;
      try {
        const session = await authRequest(fetcher, normalizeServerUrl(settings.serverUrl), "get-session", sessionSchema, { token: accountToken, signal: controller.signal });
        if (controller.signal.aborted) return;
        const ready = readyRef.current;
        if (!session || session.user.id !== ready?.identity.user.id || Date.parse(session.session.expiresAt) <= Date.now()) {
          void leaveRef.current("Your session has expired. Sign in again.", false);
          return;
        }
        currentExpiry = Date.parse(session.session.expiresAt);
        scheduleExpiry();
      } catch (error) {
        if (!controller.signal.aborted && error instanceof AuthenticationError && error.status === 401) {
          void leaveRef.current("Your session has expired. Sign in again.", false);
        }
        // Offline validation cannot establish expiry; the local expiry and domain 401 still apply.
      } finally { validating = false; }
    };
    scheduleExpiry();
    const interval = setInterval(() => { void validate(); }, 60_000);
    window.addEventListener("focus", validate);
    return () => { controller.abort(); clearInterval(interval); clearTimeout(expiryTimer); window.removeEventListener("focus", validate); };
  }, [accountToken, expiresAt, settings.serverUrl, fetcher]);

  const authenticate = async (values: { name?: string; email: string; password: string }) => {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted) return;
    const serverUrl = normalizeServerUrl(settings.serverUrl);
    const result = await authRequest(fetcher, serverUrl, values.name === undefined ? "sign-in/email" : "sign-up/email", authResultSchema, { body: values, signal });
    const session = await authRequest(fetcher, serverUrl, "get-session", sessionSchema, { token: result.token, signal });
    if (!session || session.user.id !== result.user.id) throw new Error("The server did not establish your session. Sign in again.");
    if (signal.aborted) return;
    resetAppSessionNavigation();
    await acceptSession(session, serverUrl, signal);
    void landAfterSignIn(signal, values.name !== undefined);
  };

  // Sign-up opens the first chat when a model is ready; without one the ModelGate shows first and opens that chat
  // once a provider is added, so only one place navigates.
  const landAfterSignIn = async (signal: AbortSignal, signUp: boolean) => {
    if (!signUp) return;
    try {
      if ((await readyRef.current?.client?.modelProviders.list())?.usable === false) return;
    } catch { /* fall through: open the chat; the in-chat notice still shows */ }
    await openFirstChat(signal);
  };

  // Sign-up creates the default agent and its chat; land in that chat like Muse does.
  // The chat may land a moment after the session, so retry briefly, then stay on the index.
  const openFirstChat = async (signal: AbortSignal) => {
    for (let attempt = 0; attempt < 6 && !signal.aborted; attempt++) {
      try {
        const client = readyRef.current?.client;
        const direct = client && (await client.conversations.list()).items.find((c) => c.kind === "direct");
        if (direct) { openAppConversation(direct.id); return; }
      } catch { /* the index still works */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };

  if (state.kind === "ready") {
    return (
      <AuthContext value={state.identity}>
        <ServerConnectionContext
          value={{ serverUrl: settings.serverUrl, onChangeServer: onChangeServer ?? null }}
        >
          {renderApp({ client: state.client, platform, queryClient: state.queryClient, theme })}
        </ServerConnectionContext>
      </AuthContext>
    );
  }
  const formMessage = state.kind === "form" ? state.message : undefined;
  const revealed = entered || formMessage !== undefined;
  const compact = state.kind === "form" && revealed;
  const showWelcome = state.kind === "form" && !revealed;
  return (
    <ThemeProvider defaultTheme={theme}>
      <main className="al1-auth bg-background text-fg">
        {platform.isDesktop ? <DragStrip /> : null}
        <div className="al1-inner">
          <AccountScene compact={compact} />
          {state.kind === "loading" ? <p role="status" className="al1-status text-center text-sm text-fg-muted"><span className="al1-spinner" aria-hidden="true" />{state.message}</p> : null}
          {state.kind === "error" ? <div className="al1-formwrap">
            <div className="al1-heading al1-enter">
              <h1 className={SCREEN_TITLE}>Could not connect</h1>
              <p role="alert" className="al1-error mt-1.5 text-sm text-danger">{state.message}</p>
            </div>
            <Button className="al1-enter al1-d1" onClick={() => setRetry((value) => value + 1)}>Try again</Button>
          </div> : null}
          {showWelcome ? <div className="al1-welcome al1-enter">
            <button type="button" className="al1-signin" onClick={() => setEntered(true)}>Sign in<span aria-hidden="true"> →</span></button>
          </div> : null}
          {state.kind === "form" && revealed ? <AccountForm message={formMessage} authenticate={authenticate} /> : null}
          {onChangeServer && state.kind !== "loading" ? <button type="button" className="al1-server text-sm text-fg-muted" onClick={onChangeServer}>Change server</button> : null}
        </div>
      </main>
    </ThemeProvider>
  );
}
