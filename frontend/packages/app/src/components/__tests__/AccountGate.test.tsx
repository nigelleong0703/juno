import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlatformAdapter, PlatformSecretStore } from "../../platform";
import { webPlatform } from "../../platform";
import { useAuthIdentity, useCurrentUser } from "../../auth/AuthContext";
import { sessionSecretKey } from "../../auth/account";
import { useUiStore } from "../../store/ui";
import { AccountGate, type GateAppProps } from "../AccountGate";
import { TOKEN_USER } from "../../lib/people";

const tokenIdentity = `${TOKEN_USER.name} · ${TOKEN_USER.initials} · ${TOKEN_USER.id}`;
const settings = { serverUrl: "https://accounts.example:9443", apiToken: "dev-token" };
const alice = { id: "owner-alice", name: "Alice Chen", email: "alice@example.com" };
const bob = { id: "owner-bob", name: "Bob Li", email: "bob@example.com" };
const expiresAt = () => new Date(Date.now() + 3600_000).toISOString();
const session = (user = alice, token = "alice-session", expiry = expiresAt()) => ({ user, session: { token, expiresAt: expiry } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
function pathOf(input: RequestInfo | URL) { return new URL(input instanceof Request ? input.url : String(input)).pathname; }
function defaultFetcher() {
  return vi.fn<typeof fetch>(async (input) => {
    const path = pathOf(input);
    if (path === "/auth/info") return json({ mode: "account", providers: ["credential"] });
    if (path === "/auth/get-session") return json(null);
    throw new Error(`Unexpected request: ${path}`);
  });
}
function Identity({ props, stream = false }: { props: GateAppProps; stream?: boolean }) {
  const owner = useCurrentUser();
  const identity = useAuthIdentity();
  useEffect(() => {
    if (stream) return props.client.subscribe?.(() => {});
  }, [props.client, stream]);
  return <div>
    <p>{owner.name} · {owner.initials} · {owner.id}</p>
    {identity?.mode === "account" ? <button onClick={identity.signOut}>Sign out</button> : null}
    <button onClick={() => { void props.client.agents.list().catch(() => {}); }}>Load domain</button>
  </div>;
}
const showIdentity = (props: GateAppProps) => <Identity props={props} />;
function desktop(secrets: PlatformSecretStore = { get: vi.fn(async () => "encrypted-session"), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) }): PlatformAdapter {
  return { ...webPlatform, isDesktop: true, secrets, allowServerOrigin: vi.fn(async () => ({ origin: settings.serverUrl, reloadRequired: false })) };
}
async function fillSignIn(password = "valid-password") {
  await screen.findByRole("button", { name: "Sign in" });
  if (!screen.queryByLabelText("Email")) {
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("Email");
  }
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: alice.email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}
beforeEach(() => {
  // jsdom supplies DOM AbortSignals while react-router uses Node's Request constructor.
  const FetchRequest = globalThis.Request;
  vi.stubGlobal("Request", class extends FetchRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(input, { ...init, signal: undefined }); }
  });
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear() });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); useUiStore.setState({ composeRecipients: [] }); vi.unstubAllGlobals(); });

describe("shared AccountGate", () => {

  it("recognizes only the old Hono 404 after an authenticated valid legacy API probe", async () => {
    const fetcher = defaultFetcher(); let finishProbe: ((response: Response) => void) | undefined;
    fetcher.mockImplementation(async (input) => {
      if (pathOf(input) === "/auth/info") return new Response("404 Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=UTF-8" } });
      return new Promise((resolve) => { finishProbe = resolve; });
    });
    const renderApp = vi.fn(showIdentity);
    render(<AccountGate settings={{ ...settings, apiToken: "configured-legacy-token" }} fetcher={fetcher} renderApp={renderApp} />);
    await waitFor(() => expect(finishProbe).toBeDefined());
    expect(renderApp).not.toHaveBeenCalled();
    const request = fetcher.mock.calls[1];
    expect(pathOf(request?.[0] ?? "https://missing.invalid")).toBe("/v1/agents");
    expect(new Headers(request?.[1]?.headers).get("Authorization")).toBe("Bearer configured-legacy-token");
    expect(request?.[1]?.credentials).toBe("same-origin");
    expect(request?.[1]?.redirect).toBe("error");
    await act(async () => { finishProbe?.(json({ items: [], nextCursor: null })); });
    await screen.findByText(tokenIdentity);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it.each([true, false])("keeps tunnel cookies only for same-origin legacy transport (sameOrigin=%s)", async (sameOrigin) => {
    const pageOrigin = window.location.origin;
    const serverUrl = sameOrigin ? pageOrigin : "https://custom-server.example";
    const fetcher = defaultFetcher(); let cookieSent: boolean | undefined;
    fetcher.mockImplementation(async (input, init) => {
      if (pathOf(input) === "/auth/info") return new Response("404 Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
      // Model browser credential policy at the tunnel boundary. Omitting this cookie would
      // redirect a same-origin tunnel request to login; cross-origin servers must not receive it.
      const origin = new URL(String(input)).origin;
      cookieSent = init?.credentials === "include" || (init?.credentials === "same-origin" && origin === pageOrigin);
      expect(cookieSent).toBe(sameOrigin);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer configured-token");
      expect(init?.redirect).toBe("error");
      if (sameOrigin && !cookieSent) throw new TypeError("Tunnel login redirect blocked");
      return json({ items: [], nextCursor: null });
    });
    render(<AccountGate settings={{ ...settings, serverUrl, apiToken: "configured-token" }} fetcher={fetcher} renderApp={showIdentity} />);
    await screen.findByText(tokenIdentity);
    expect(cookieSent).toBe(sameOrigin);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("requires a nonempty application Bearer even when tunnel cookies are available", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("404 Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }));
    const renderApp = vi.fn(showIdentity);
    render(<AccountGate settings={{ ...settings, serverUrl: window.location.origin, apiToken: "  " }} fetcher={fetcher} renderApp={renderApp} />);
    await screen.findByText("This legacy server requires an API token.");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(renderApp).not.toHaveBeenCalled();
  });

  it.each(["Network unavailable", "Tunnel login redirect blocked"])("never mounts legacy data after probe transport failure: %s", async (message) => {
    const fetcher = defaultFetcher(); const renderApp = vi.fn(showIdentity);
    fetcher.mockImplementation(async (input, init) => {
      if (pathOf(input) === "/auth/info") return new Response("404 Not Found", { status: 404, headers: { "Content-Type": "text/plain" } });
      expect(init?.credentials).toBe("same-origin"); expect(init?.redirect).toBe("error");
      throw new TypeError(message);
    });
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={renderApp} />);
    await screen.findByText(message); expect(renderApp).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "401 probe", status: 401, body: { error: { message: "Wrong API token" } } },
    { label: "500 probe", status: 500, body: { error: { message: "Backend unavailable" } } },
    { label: "invalid 200 probe", status: 200, body: { items: [{ id: "not-an-agent" }], nextCursor: null } },
  ])("refuses legacy discovery for $label", async ({ status, body }) => {
    const fetcher = defaultFetcher();
    fetcher.mockImplementation(async (input) => pathOf(input) === "/auth/info"
      ? new Response("404 Not Found", { status: 404, headers: { "Content-Type": "text/plain" } }) : json(body, status));
    const renderApp = vi.fn(showIdentity);
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={renderApp} />);
    await screen.findByRole("alert"); expect(renderApp).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "JSON 404", response: () => json({ error: { code: "NOT_FOUND", message: "missing" } }, 404) },
    { label: "HTML 404", response: () => new Response("404 Not Found", { status: 404, headers: { "Content-Type": "text/html" } }) },
    { label: "other text 404", response: () => new Response("Unknown route", { status: 404, headers: { "Content-Type": "text/plain" } }) },
    { label: "401 discovery", response: () => json({ message: "Unauthorized" }, 401) },
    { label: "network failure", response: () => { throw new TypeError("Failed to fetch"); } },
  ])("does not probe a server after $label", async ({ response }) => {
    const fetcher = vi.fn<typeof fetch>(async () => response()); const renderApp = vi.fn(showIdentity);
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={renderApp} />);
    await screen.findByRole("alert"); expect(renderApp).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });


  it("preserves a fresh restored session through StrictMode bootstrap replay", async () => {
    const fetcher = defaultFetcher();
    fetcher.mockImplementation(async (input) => pathOf(input) === "/auth/info" ? json({ mode: "account", providers: ["credential"] }) : json(session()));
    render(<StrictMode><AccountGate settings={settings} fetcher={fetcher} renderApp={showIdentity} /></StrictMode>);
    await screen.findByText("Alice Chen · AC · owner-alice");
    fireEvent.click(screen.getByRole("button", { name: "Load domain" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => pathOf(input).startsWith("/v1/"))).toBe(true));
    expect(screen.getByText("Alice Chen · AC · owner-alice")).toBeDefined();
  });

  it("shows sign-in for an unauthorized encrypted session and removes the expired token", async () => {
    const fetcher = defaultFetcher(); const platform = desktop();
    fetcher.mockImplementation(async (input) => pathOf(input) === "/auth/info" ? json({ mode: "account", providers: ["credential"] }) : json({ message: "Expired" }, 401));
    render(<AccountGate settings={settings} platform={platform} fetcher={fetcher} renderApp={showIdentity} />);
    await screen.findByRole("button", { name: "Sign in" });
    expect(screen.getByText("Your session has expired. Sign in again.")).toBeDefined();
    expect(platform.secrets?.delete).toHaveBeenCalledWith(sessionSecretKey(settings.serverUrl));
  });

  it("revalidates on focus and clears a session revoked elsewhere", async () => {
    const fetcher = defaultFetcher(); let revoked = false;
    fetcher.mockImplementation(async (input) => pathOf(input) === "/auth/info" ? json({ mode: "account", providers: ["credential"] }) : json(revoked ? null : session()));
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={showIdentity} />);
    await screen.findByText("Alice Chen · AC · owner-alice");
    revoked = true; fireEvent.focus(window);
    await screen.findByText("Your session has expired. Sign in again.");
  });

  it("waits for native CSP registration before auth info or domain requests", async () => {
    let allow: ((value: null) => void) | undefined;
    const platform = desktop();
    platform.allowServerOrigin = vi.fn(() => new Promise<null>((resolve) => { allow = resolve; }));
    const fetcher = defaultFetcher();
    const renderApp = vi.fn(showIdentity);
    render(<AccountGate settings={settings} platform={platform} fetcher={fetcher} renderApp={renderApp} />);
    expect(fetcher).not.toHaveBeenCalled(); expect(renderApp).not.toHaveBeenCalled();
    await act(async () => { allow?.(null); });
    await screen.findByRole("button", { name: "Sign in" });
    expect(pathOf(fetcher.mock.calls[0]?.[0] ?? "https://missing.invalid")).toBe("/auth/info");
    expect(renderApp).not.toHaveBeenCalled();
  });

  it("restores web cookies into memory bearer without using localStorage or developer token", async () => {
    const fetcher = defaultFetcher();
    fetcher.mockImplementation(async (input) => pathOf(input) === "/auth/info" ? json({ mode: "account", providers: ["credential"] }) : json(session()));
    const secrets = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const renderApp = vi.fn(showIdentity);
    render(<AccountGate settings={settings} platform={{ ...webPlatform, secrets }} fetcher={fetcher} renderApp={renderApp} />);
    await screen.findByText("Alice Chen · AC · owner-alice");
    expect(secrets.get).not.toHaveBeenCalled(); expect(secrets.set).not.toHaveBeenCalled();
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Authorization")).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => init?.credentials === "include")).toBe(true);
    expect(JSON.stringify(localStorage)).not.toContain("alice-session");
    expect(renderApp.mock.lastCall?.[0].queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it("restores native sessions from encrypted secrets keyed by normalized origin", async () => {
    const platform = desktop(); const fetcher = defaultFetcher();
    fetcher.mockImplementation(async (input) => pathOf(input) === "/auth/info" ? json({ mode: "account", providers: ["credential"] }) : json(session()));
    render(<AccountGate settings={{ ...settings, serverUrl: `${settings.serverUrl}/` }} platform={platform} fetcher={fetcher} renderApp={showIdentity} />);
    await screen.findByText("Alice Chen · AC · owner-alice");
    expect(platform.secrets?.get).toHaveBeenCalledWith(sessionSecretKey(settings.serverUrl));
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer encrypted-session");
    expect(platform.secrets?.set).toHaveBeenCalledWith(sessionSecretKey(settings.serverUrl), "alice-session");
  });

  it("signs up through the real contract, verifies the session before mounting, never stores passwords", async () => {
    let signedIn = false;
    const fetcher = defaultFetcher(); const platform = desktop({ get: vi.fn(async () => null), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) });
    fetcher.mockImplementation(async (input) => {
      const path = pathOf(input);
      if (path === "/auth/info") return json({ mode: "account", providers: ["credential"] });
      if (path === "/auth/sign-up/email") { signedIn = true; return json({ token: "alice-session", user: alice }); }
      return json(signedIn ? session() : null);
    });
    render(<AccountGate settings={settings} platform={platform} fetcher={fetcher} renderApp={showIdentity} />);
    await screen.findByRole("button", { name: "Sign in" });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByLabelText("Email");
    fireEvent.click(await screen.findByRole("button", { name: "Create an account" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Alice Chen" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: alice.email } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "not-saved-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await screen.findByText("Alice Chen · AC · owner-alice");
    const signup = fetcher.mock.calls.find(([input]) => pathOf(input) === "/auth/sign-up/email");
    expect(JSON.parse(String(signup?.[1]?.body))).toEqual({ name: "Alice Chen", email: alice.email, password: "not-saved-password" });
    expect(platform.secrets?.set).toHaveBeenCalledWith(sessionSecretKey(settings.serverUrl), "alice-session");
    expect(JSON.stringify(localStorage)).not.toContain("not-saved-password");
  });

  it("disables a pending sign-in, shows server errors and clears the password on failure", async () => {
    const fetcher = defaultFetcher(); let rejectLogin: ((response: Response) => void) | undefined;
    fetcher.mockImplementation(async (input) => {
      const path = pathOf(input);
      if (path === "/auth/info") return json({ mode: "account", providers: ["credential"] });
      if (path === "/auth/sign-in/email") return new Promise((resolve) => { rejectLogin = resolve; });
      return json(null);
    });
    const renderApp = vi.fn(showIdentity);
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={renderApp} />);
    await fillSignIn();
    expect(screen.getByRole("group").hasAttribute("disabled")).toBe(true);
    expect(renderApp).not.toHaveBeenCalled();
    await act(async () => { rejectLogin?.(json({ message: "Invalid email or password" }, 401)); });
    await screen.findByText("Invalid email or password");
    expect(screen.getByLabelText("Password").getAttribute("value")).toBe("");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
  });

  it.each([json({ mode: "surprise", providers: [] }), json({ message: "Offline" }, 503)])("fails honestly on unknown mode or auth error without legacy fallback", async (response) => {
    const fetcher = vi.fn<typeof fetch>(async () => response); const renderApp = vi.fn(showIdentity);
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={renderApp} />);
    await screen.findByRole("alert");
    expect(renderApp).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows legacy token mode only when auth info explicitly selects it", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ mode: "token", providers: [] }));
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={showIdentity} />);
    await screen.findByText(tokenIdentity);
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("does not let a stale demo flag bypass real account discovery", async () => {
    // The removed demo path read this legacy localStorage flag and mounted an invented identity
    // without any server call; a real client must always discover the account mode first.
    localStorage.setItem("agent-desktop-use-mock", "true");
    const fetcher = defaultFetcher();
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={showIdentity} />);
    await screen.findByRole("button", { name: "Sign in" });
    expect(pathOf(fetcher.mock.calls[0]?.[0] ?? "https://missing.invalid")).toBe("/auth/info");
    expect(screen.queryByText(tokenIdentity)).toBeNull();
  });

  it("revokes on logout, aborts streams, clears cache/drafts/routes, then starts Bob with a new cache", async () => {
    let current: typeof alice | null = alice;
    let streamSignal: AbortSignal | null | undefined;
    const fetcher = defaultFetcher(); const platform = desktop(); const renderApp = vi.fn((props: GateAppProps) => <Identity props={props} stream />);
    fetcher.mockImplementation(async (input, init) => {
      const path = pathOf(input);
      if (path === "/auth/info") return json({ mode: "account", providers: ["credential"] });
      if (path === "/auth/get-session") return json(current ? session(current, `${current.id}-session`) : null);
      if (path === "/auth/sign-out") { current = null; return json({ success: true }); }
      if (path === "/auth/sign-in/email") { current = bob; return json({ token: "owner-bob-session", user: bob }); }
      if (path === "/v1/events") { streamSignal = init?.signal; return new Promise(() => {}); }
      throw new Error(path);
    });
    render(<AccountGate settings={settings} platform={platform} fetcher={fetcher} renderApp={renderApp} />);
    await screen.findByText("Alice Chen · AC · owner-alice");
    const aliceCache = renderApp.mock.lastCall?.[0].queryClient;
    aliceCache?.setQueryData(["conversations"], ["alice-private"]);
    useUiStore.setState({ composeRecipients: [{ key: "private", kind: "agent", agentId: "alice-agent", name: "private" }], theme: "light" });
    window.location.hash = "#/c/alice-chat";
    await waitFor(() => expect(streamSignal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("button", { name: "Sign in" });
    expect(streamSignal?.aborted).toBe(true); expect(aliceCache?.getQueryCache().getAll()).toEqual([]);
    expect(useUiStore.getState().composeRecipients).toEqual([]); expect(useUiStore.getState().theme).toBe("light");
    expect(window.location.hash).toBe("#/"); expect(platform.secrets?.delete).toHaveBeenCalledWith(sessionSecretKey(settings.serverUrl));
    const signout = fetcher.mock.calls.find(([input]) => pathOf(input) === "/auth/sign-out");
    expect(new Headers(signout?.[1]?.headers).get("Authorization")).toBe("Bearer owner-alice-session"); expect(signout?.[1]?.body).toBe("{}");
    await fillSignIn(); await screen.findByText("Bob Li · BL · owner-bob");
    expect(window.location.hash).toBe("#/");
    const bobCache = renderApp.mock.lastCall?.[0].queryClient;
    expect(bobCache).not.toBe(aliceCache); expect(bobCache?.getQueryData(["conversations"])).toBeUndefined();
  });

  it("clears UI/cache/encrypted bearer even when server sign-out fails", async () => {
    const fetcher = defaultFetcher(); const platform = desktop(); const renderApp = vi.fn(showIdentity);
    fetcher.mockImplementation(async (input) => {
      const path = pathOf(input);
      if (path === "/auth/info") return json({ mode: "account", providers: ["credential"] });
      if (path === "/auth/sign-out") return json({ message: "Cannot revoke" }, 503);
      return json(session());
    });
    render(<AccountGate settings={settings} platform={platform} fetcher={fetcher} renderApp={renderApp} />);
    await screen.findByText("Alice Chen · AC · owner-alice");
    const qc = renderApp.mock.lastCall?.[0].queryClient; qc?.setQueryData(["private"], "alice");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText(/Server sign-out failed: Cannot revoke/);
    expect(qc?.getQueryCache().getAll()).toEqual([]); expect(platform.secrets?.delete).toHaveBeenCalled();
    expect(screen.queryByText("Alice Chen · AC · owner-alice")).toBeNull();
  });

  it.each([false, true])("returns to the gate on domain or background SSE 401 (stream=%s)", async (stream) => {
    const fetcher = defaultFetcher();
    fetcher.mockImplementation(async (input) => {
      const path = pathOf(input);
      if (path === "/auth/info") return json({ mode: "account", providers: ["credential"] });
      if (path === "/auth/get-session") return json(session());
      return json({ error: { message: "Unauthorized" } }, 401);
    });
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={(props) => <Identity props={props} stream={stream} />} />);
    if (!stream) { await screen.findByText("Alice Chen · AC · owner-alice"); fireEvent.click(screen.getByRole("button", { name: "Load domain" })); }
    await screen.findByText("Your session has expired. Sign in again.");
    expect(screen.queryByText("Alice Chen · AC · owner-alice")).toBeNull();
  });

  it("expires an idle session without mounting any further domain requests", async () => {
    const fetcher = defaultFetcher();
    fetcher.mockImplementation(async (input) => pathOf(input) === "/auth/info" ? json({ mode: "account", providers: ["credential"] }) : json(session(alice, "alice-session", new Date(Date.now() + 500).toISOString())));
    render(<AccountGate settings={settings} fetcher={fetcher} renderApp={showIdentity} />);
    await screen.findByText("Alice Chen · AC · owner-alice");
    await screen.findByText("Your session has expired. Sign in again.");
    expect(fetcher.mock.calls.some(([input]) => pathOf(input).startsWith("/v1/"))).toBe(false);
  });

  it("ignores a late restore after server change and aborts current auth requests on unmount", async () => {
    let oldRestore: ((response: Response) => void) | undefined; let signal: AbortSignal | null | undefined;
    const fetcher = defaultFetcher();
    fetcher.mockImplementation(async (input, init) => {
      if (pathOf(input) === "/auth/info") return json({ mode: "account", providers: ["credential"] });
      if (String(input).includes("accounts.example")) return new Promise((resolve) => { oldRestore = resolve; signal = init?.signal; });
      return json(null);
    });
    const view = render(<AccountGate settings={settings} fetcher={fetcher} renderApp={showIdentity} />);
    await waitFor(() => expect(oldRestore).toBeDefined());
    view.rerender(<AccountGate settings={{ ...settings, serverUrl: "https://other.example" }} fetcher={fetcher} renderApp={showIdentity} />);
    await screen.findByRole("button", { name: "Sign in" }); expect(signal?.aborted).toBe(true);
    await act(async () => { oldRestore?.(json(session())); });
    expect(screen.queryByText("Alice Chen · AC · owner-alice")).toBeNull();
    view.unmount();
  });
});
