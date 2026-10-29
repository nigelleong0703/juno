import type { ApiClient } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { qk } from "../../../data/keys";
import { ServerConnectionContext } from "../../../components/ServerConnection";
import { webPlatform, type PlatformAdapter } from "../../../platform";
import { usePersistedTheme } from "../../../lib/persistedTheme";
import { AgentSettingsPage } from "../../agents/AgentSettingsPage";
import { AppSettingsPage } from "../AppSettingsPage";


// Node 26 leaves window.localStorage unavailable under jsdom; back it with an
// in-memory store like the other suites do.
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderAt(
  path: string,
  client: ApiClient,
  options?: { platform?: PlatformAdapter; serverUrl?: string; onChangeServer?: () => void },
) {
  const queryClient = testQueryClient();
  const gate =
    options?.serverUrl !== undefined || options?.onChangeServer !== undefined
      ? {
          serverUrl: options.serverUrl ?? "http://127.0.0.1:8787",
          onChangeServer: options.onChangeServer ?? null,
        }
      : null;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
      <ClientProvider
        client={client}
        queryClient={queryClient}
        platform={options?.platform ?? webPlatform}
      >
        {gate ? (
          <ServerConnectionContext value={gate}>{children}</ServerConnectionContext>
        ) : (
          children
        )}
      </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/:section?" element={<AppSettingsPage />} />
        <Route path="/agents/:agentId/settings/:section?" element={<AgentSettingsPage />} />
      </Routes>
    </MemoryRouter>,
    { wrapper },
  );
  return queryClient;
}

function ThemeConsumer({ id }: { id: string }) {
  const { theme, setPersistedTheme, saveFailed } = usePersistedTheme();
  return (
    <div>
      <span data-testid={"theme-" + id}>{theme}</span>
      <button type="button" onClick={() => setPersistedTheme("light")}>
        {"to-light-" + id}
      </button>
      <button type="button" onClick={() => setPersistedTheme("dark")}>
        {"to-dark-" + id}
      </button>
      {saveFailed ? <span data-testid={"failed-" + id}>save failed</span> : null}
    </div>
  );
}
 
function renderThemes(client: ApiClient): QueryClient {
  const queryClient = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider defaultTheme="dark">
      <ClientProvider client={client} queryClient={queryClient} platform={webPlatform}>
        {children}
      </ClientProvider>
    </ThemeProvider>
  );
  render(
    <>
      <ThemeConsumer id="a" />
      <ThemeConsumer id="b" />
    </>,
    { wrapper },
  );
  return queryClient;
}
 
function deferredUpdates(base: ApiClient) {
  const queue: Array<{
    patch: Parameters<ApiClient["settings"]["update"]>[0];
    resolve: (value: Awaited<ReturnType<ApiClient["settings"]["update"]>>) => void;
    reject: (error: unknown) => void;
  }> = [];
  const wired: ApiClient = {
    ...base,
    settings: {
      ...base.settings,
      update: (patch) =>
        new Promise<Awaited<ReturnType<ApiClient["settings"]["update"]>>>((resolve, reject) => {
          queue.push({ patch, resolve, reject });
        }),
    },
  };
  return {
    wired,
    queue,
    async flushOk(index: number, ok: boolean): Promise<void> {
      const item = queue[index];
      if (!item) throw new Error("no pending theme PATCH");
      if (ok) item.resolve(await base.settings.update(item.patch));
      else item.reject(new Error("PATCH refused"));
    },
  };
}
describe("AppSettingsPage profile", () => {
  it("saves the owner's about-you text through settings", async () => {
    const client = createMockClient({ seed: 7 });
    renderAt("/settings/profile", client);
    const box = await screen.findByLabelText("About you");
    fireEvent.change(box, { target: { value: "I prefer short answers." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await client.home.list("USER.md")).files[0]?.content).toBe("I prefer short answers."));
  });
});
describe("AgentSettingsPage model section", () => {
  it("renders the same profile editor on the legacy model URL", async () => {
    const client = createMockClient({ seed: 7 });
    const agent = await client.agents.get("agent-juno");
    renderAt("/agents/agent-juno/settings/model", client);
    // The page is the agent card (MUSE-PARITY step 7); its Memory tab holds the profile form.
    expect(await screen.findByRole("heading", { name: agent.name, level: 2 })).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: "Edit agent" }));
    const name = await screen.findByLabelText("Name");
    expect((name as HTMLInputElement).value).toBe(agent.name);
    expect(screen.queryByRole("button", { name: "Open global Models" })).toBeNull();
    expect(screen.queryByText(/no per-agent override/)).toBeNull();
  });
});

describe("AppSettingsPage connection", () => {
  it("shows the actual gate server and calls the real switch flow", async () => {
    const client = createMockClient({ seed: 7 });
    const onChangeServer = vi.fn();
    renderAt("/settings/connection", client, {
      serverUrl: "https://gate.example.com",
      onChangeServer,
    });
    await waitFor(() => expect(screen.getByText("https://gate.example.com")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Switch server" }));
    expect(onChangeServer).toHaveBeenCalledTimes(1);
  });

  it("hides the switch button when no real flow is available", async () => {
    const client = createMockClient({ seed: 7 });
    renderAt("/settings/connection", client);
    await waitFor(() => expect(screen.getByText("Current server")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Switch server" })).toBeNull();
  });

  it("wires launch-at-login to the desktop bridge and reports failures", async () => {
    const client = createMockClient({ seed: 7 });
    const login = {
      get: vi.fn(async () => true),
      set: vi.fn(async (_next: boolean) => {
        throw new Error("bridge denied");
      }),
    };
    renderAt("/settings/connection", client, {
      platform: { ...webPlatform, launchAtLogin: login },
    });
    await waitFor(() => expect(screen.getByText("Launch at login")).toBeDefined());
    const toggle = screen.getByRole("switch");
    expect((toggle as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText("bridge denied")).toBeDefined());
    expect((toggle as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
  });
});
describe("My Mac settings", () => {
  const link = (overrides: Partial<import("../../../platform").MyMacLinkState> = {}): import("../../../platform").MyMacLinkState => ({
    paired: false, status: "offline", running: 0, stopped: false, deviceName: "Test Mac", folder: "/Users/you/Juno", ...overrides,
  });

  it("pairs through the server, hands the token to the desktop shell, and disconnects both ends", async () => {
    const client = createMockClient({ seed: 7 });
    const connect = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const mac = { state: async () => link(), onState: () => () => undefined, connect, disconnect, setStopped: vi.fn() };
    renderAt("/settings/mac", client, { platform: { ...webPlatform, isDesktop: true, myMac: mac } });

    fireEvent.click(await screen.findByRole("button", { name: "Connect this Mac" }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: "mac-mock", token: "mock-token" })));
    expect((await client.computers.myMac()).paired).toBe(true);
    // The shell reports the link is up; Disconnect revokes on the server and forgets the pairing locally.
    mac.state = async () => link({ paired: true, status: "online" });
    cleanup();
    renderAt("/settings/mac", client, { platform: { ...webPlatform, isDesktop: true, myMac: mac } });
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnect).toHaveBeenCalled());
    expect((await client.computers.myMac()).paired).toBe(false);
  });

  it("shows what is running with a Stop that reaches the shell, and Resume after it", async () => {
    const client = createMockClient({ seed: 7 });
    await client.computers.pairMyMac({});
    const setStopped = vi.fn();
    let listener: (state: import("../../../platform").MyMacLinkState) => void = () => undefined;
    const mac = { state: async () => link({ paired: true, status: "online", running: 1, command: "ls -la" }), onState: (next: typeof listener) => { listener = next; return () => undefined; }, connect: vi.fn(), disconnect: vi.fn(), setStopped };
    renderAt("/settings/mac", client, { platform: { ...webPlatform, isDesktop: true, myMac: mac } });

    expect(await screen.findByText("Running: ls -la")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(setStopped).toHaveBeenCalledWith(true);
    listener(link({ paired: true, status: "online", stopped: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(setStopped).toHaveBeenCalledWith(false);
  });

  it("on the web only shows the state and can disconnect", async () => {
    const client = createMockClient({ seed: 7 });
    await client.computers.pairMyMac({ name: "Robin's Mac" });
    renderAt("/settings/mac", client);
    expect(await screen.findByText("Robin's Mac")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Connect this Mac" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(async () => expect((await client.computers.myMac()).paired).toBe(false));
  });
});
describe("usePersistedTheme across consumers", () => {
  it("holds the new choice in both consumers until the delayed PATCH succeeds", async () => {
    const base = createMockClient({ seed: 7 });
    await base.settings.update({ appearance: { theme: "dark" } });
    const deferred = deferredUpdates(base);
    const qc = renderThemes(deferred.wired);
    await waitFor(() => expect(qc.getQueryData(qk.settings())).toBeDefined());
    await waitFor(() => expect(screen.getByTestId("theme-a").textContent).toBe("dark"));

    fireEvent.click(screen.getByText("to-light-a"));
    expect(screen.getByTestId("theme-a").textContent).toBe("light");
    expect(screen.getByTestId("theme-b").textContent).toBe("light");

    await deferred.flushOk(0, true);
    await waitFor(() => expect(screen.getByTestId("theme-b").textContent).toBe("light"));
    expect((await base.settings.get()).appearance.theme).toBe("light");
  });

  it("rolls both consumers back and reports when the PATCH fails", async () => {
    const base = createMockClient({ seed: 7 });
    await base.settings.update({ appearance: { theme: "dark" } });
    const deferred = deferredUpdates(base);
    const qc = renderThemes(deferred.wired);
    await waitFor(() => expect(qc.getQueryData(qk.settings())).toBeDefined());
    await waitFor(() => expect(screen.getByTestId("theme-a").textContent).toBe("dark"));

    fireEvent.click(screen.getByText("to-light-b"));
    expect(screen.getByTestId("theme-a").textContent).toBe("light");

    await deferred.flushOk(0, false);
    await waitFor(() => expect(screen.getByTestId("theme-a").textContent).toBe("dark"));
    expect(screen.getByTestId("theme-b").textContent).toBe("dark");
    expect(screen.getByTestId("failed-b")).toBeDefined();
  });

  it("serializes rapid changes so the latest choice wins", async () => {
    const base = createMockClient({ seed: 7 });
    await base.settings.update({ appearance: { theme: "dark" } });
    const deferred = deferredUpdates(base);
    const qc = renderThemes(deferred.wired);
    await waitFor(() => expect(qc.getQueryData(qk.settings())).toBeDefined());
    await waitFor(() => expect(screen.getByTestId("theme-a").textContent).toBe("dark"));

    fireEvent.click(screen.getByText("to-light-a"));
    fireEvent.click(screen.getByText("to-dark-b"));
    expect(deferred.queue).toHaveLength(1);

    await deferred.flushOk(0, true);
    await waitFor(() => expect(deferred.queue).toHaveLength(2));
    await deferred.flushOk(1, true);
    await waitFor(() => expect(screen.getByTestId("theme-a").textContent).toBe("dark"));
    expect((await base.settings.get()).appearance.theme).toBe("dark");
  });
});
describe("usePersistedTheme session isolation", () => {
  function SessionConsumer({ id }: { id: string }) {
    const { theme, setPersistedTheme } = usePersistedTheme();
    return (
      <div>
        <span data-testid={"session-theme-" + id}>{theme}</span>
        <button type="button" onClick={() => setPersistedTheme("light")}>
          {"session-light-" + id}
        </button>
      </div>
    );
  }

  function renderSession(
    client: ApiClient,
    id: string,
  ): { qc: QueryClient; unmount: () => void } {
    const queryClient = testQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ThemeProvider defaultTheme="dark">
        <ClientProvider client={client} queryClient={queryClient} platform={webPlatform}>
          {children}
        </ClientProvider>
      </ThemeProvider>
    );
    const { unmount } = render(<SessionConsumer id={id} />, { wrapper });
    return { qc: queryClient, unmount };
  }

  it("keeps two sessions independent and survives initiator unmount", async () => {
    const baseA = createMockClient({ seed: 11 });
    const baseB = createMockClient({ seed: 12 });
    await baseA.settings.update({ appearance: { theme: "dark" } });
    await baseB.settings.update({ appearance: { theme: "dark" } });

    const gateA: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
    const clientA: ApiClient = {
      ...baseA,
      settings: {
        ...baseA.settings,
        update: (patch: Parameters<ApiClient["settings"]["update"]>[0]) =>
          new Promise<Awaited<ReturnType<ApiClient["settings"]["update"]>>>((resolve, reject) => {
            gateA.push({ resolve: () => void baseA.settings.update(patch).then(resolve, reject), reject });
          }),
      },
    };

    const sessionA = renderSession(clientA, "a");
    renderSession(baseB, "b");
    await waitFor(() => expect(sessionA.qc.getQueryData(qk.settings())).toBeDefined());
    await waitFor(() => expect(screen.getByTestId("session-theme-a").textContent).toBe("dark"));

    fireEvent.click(screen.getByText("session-light-a"));
    expect(screen.getByTestId("session-theme-a").textContent).toBe("light");
    expect(screen.getByTestId("session-theme-b").textContent).toBe("dark");

    sessionA.unmount();
    gateA[0]?.resolve();
    await waitFor(() => expect(screen.getByTestId("session-theme-b").textContent).toBe("dark"));
    expect((await baseA.settings.get()).appearance.theme).toBe("light");

    fireEvent.click(screen.getByText("session-light-b"));
    await waitFor(async () => expect((await baseB.settings.get()).appearance.theme).toBe("light"));
    expect(screen.getByTestId("session-theme-b").textContent).toBe("light");
  });
});

it("disables the theme choice until settings load, then persists it", async () => {
    const base = createMockClient({ seed: 7 });
    await base.settings.update({ appearance: { theme: "dark" } });
    const gate: { resolve?: (value: Awaited<ReturnType<ApiClient["settings"]["get"]>>) => void } = {};
    const gated: ApiClient = {
      ...base,
      settings: {
        ...base.settings,
        get: () =>
          new Promise<Awaited<ReturnType<ApiClient["settings"]["get"]>>>((resolve) => {
            gate.resolve = resolve;
          }),
      },
    };
    renderAt("/settings/appearance", gated);
    await waitFor(() => expect(screen.getByText("Light")).toBeDefined());
    const light = screen.getByText("Light").closest("button");
    expect(light?.hasAttribute("disabled") || light?.getAttribute("aria-disabled") === "true").toBe(true);

    gate.resolve?.(await base.settings.get());
    await waitFor(() => expect(light?.hasAttribute("disabled")).toBe(false));

    fireEvent.click(screen.getByText("Light"));
    await waitFor(async () => expect((await base.settings.get()).appearance.theme).toBe("light"));
  });

it("rolls a failed queued write back to the last confirmed theme", async () => {
  const base = createMockClient({ seed: 7 });
  const deferred = deferredUpdates(base);
  const qc = renderThemes(deferred.wired);
  await waitFor(() => expect(qc.getQueryData(qk.settings())).toBeDefined());
  await waitFor(() => expect(screen.getByTestId("theme-a").textContent).toBe("system"));

  fireEvent.click(screen.getByText("to-light-a"));
  fireEvent.click(screen.getByText("to-dark-b"));
  expect(deferred.queue).toHaveLength(1);
  await deferred.flushOk(0, true);
  await waitFor(() => expect(deferred.queue).toHaveLength(2));

  const el = screen.getByTestId("theme-a");
  const seen: string[] = [];
  const observer = new MutationObserver(() => {
    seen.push(el.textContent ?? "");
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });
  await deferred.flushOk(1, false);
  await waitFor(() => expect(screen.getByTestId("failed-a")).toBeDefined());
  await new Promise((resolve) => setTimeout(resolve, 50));
  observer.disconnect();

  expect(seen.includes("system")).toBe(false);
  expect(el.textContent).toBe("light");
  expect((await base.settings.get()).appearance.theme).toBe("light");
});
