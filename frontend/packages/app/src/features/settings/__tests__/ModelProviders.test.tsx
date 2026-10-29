import type { ApiClient, ChatGPTLoginStartResult, ChatGPTLoginStatus } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform, type PlatformAdapter } from "../../../platform";
import { AppSettingsPage } from "../AppSettingsPage";

// Node 26 leaves window.localStorage unavailable under jsdom; back it with an in-memory store.
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
  // cmdk (the model picker) measures and scrolls; jsdom has neither.
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderModels(client: ApiClient, platform: PlatformAdapter = webPlatform) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <ThemeProvider defaultTheme="dark">
      <ClientProvider client={client} queryClient={queryClient} platform={platform}>
        <MemoryRouter initialEntries={["/settings/models"]}>
          <Routes>
            <Route path="/settings/:section?" element={<AppSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </ClientProvider>
    </ThemeProvider>,
  );
}

/** Choose an option in a Radix Select by its trigger's label (jsdom lacks the pointer APIs Radix reads). */
async function pickOption(label: string, option: string) {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => undefined;
  fireEvent.keyDown(await screen.findByLabelText(label), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}
const typeInto = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });

function fieldValues(): string {
  return [...document.querySelectorAll("input, textarea")].map((el) => (el as HTMLInputElement).value).join("|");
}

async function addOpenAiKey(key: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
  fireEvent.click(await screen.findByText("OpenAI"));
  typeInto(await screen.findByLabelText("API key"), key);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add provider" }));
}

describe("model provider keys", () => {
  it("never echoes a key back after adding a provider or replacing its key", async () => {
    const client = createMockClient({ seed: 7, platformDefault: false });
    const update = vi.spyOn(client.modelProviders, "update");
    renderModels(client);

    await addOpenAiKey("sk-first-secret-123");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText(/Key saved/)).toBeDefined();
    expect(document.body.textContent).not.toContain("sk-first-secret-123");
    expect(fieldValues()).not.toContain("sk-first-secret-123");

    // The row menu opens from the keyboard (Radix menus ignore jsdom's synthetic pointer events).
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for OpenAI" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Replace key" }));
    typeInto(await screen.findByLabelText("API key"), "sk-second-secret-456");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.any(String), { apiKey: "sk-second-secret-456" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain("sk-second-secret-456");
    expect(fieldValues()).not.toContain("sk-second-secret-456");
    expect(screen.getByText(/Key saved/)).toBeDefined();
  });

  it("keeps the custom form open with a specific message when the endpoint is a private address", async () => {
    const client = createMockClient({ seed: 7, platformDefault: false });
    renderModels(client);

    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    fireEvent.click(await screen.findByText("Custom OpenAI-compatible endpoint"));
    typeInto(screen.getByLabelText("Name"), "My gateway");
    typeInto(screen.getByLabelText("Base URL"), "http://10.0.0.5/v1");
    typeInto(screen.getByLabelText("API key"), "sk-private-1");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add provider" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/private or local network/);
    expect((screen.getByLabelText("Base URL") as HTMLInputElement).value).toBe("http://10.0.0.5/v1");
    expect((await client.modelProviders.list()).providers).toHaveLength(0);
  });
});

describe("ChatGPT sign-in", () => {
  it("starts a fresh login after a bad paste, then connects with the new link", async () => {
    const client = createMockClient({ seed: 7, platformDefault: false });
    const started: ChatGPTLoginStartResult[] = [];
    const start = client.modelProviders.startChatGPTLogin.bind(client.modelProviders);
    client.modelProviders.startChatGPTLogin = async () => {
      const result = await start();
      started.push(result);
      return result;
    };
    const openExternal = vi.fn();
    renderModels(client, { ...webPlatform, openExternal });

    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    fireEvent.click(await screen.findByText("OpenAI"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with ChatGPT instead" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open ChatGPT sign-in" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(started[0]!.authorizationUrl));

    typeInto(await screen.findByLabelText("Address from the browser"), "http://127.0.0.1:1455/wrong");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/new sign-in link/);
    expect(started).toHaveLength(2);

    const state = new URL(started[1]!.authorizationUrl).searchParams.get("state");
    typeInto(
      screen.getByLabelText("Address from the browser"),
      `http://127.0.0.1:1455/auth/callback?code=abc&state=${state}`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Connected")).toBeDefined();
  });
});

describe("ChatGPT sign-in in the desktop app", () => {
  /** A mock whose engine catches the browser redirect itself: `finish` is the browser reaching it. */
  function automaticClient(finish: { outcome: ChatGPTLoginStatus }) {
    const client = createMockClient({ seed: 7, platformDefault: false });
    const api = client.modelProviders;
    const start = api.startChatGPTLogin.bind(api);
    api.startChatGPTLogin = async () => ({ ...(await start()), automatic: true });
    api.chatGPTLoginStatus = async () => finish.outcome;
    const cancelled: string[] = [];
    api.cancelChatGPTLogin = async (id) => void cancelled.push(id);
    return { client, cancelled };
  }

  const openDialog = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    fireEvent.click(await screen.findByText("OpenAI"));
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with ChatGPT instead" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open ChatGPT sign-in" }));
  };

  it("waits for the browser with the paste field tucked away, then closes itself when connected", async () => {
    const finish: { outcome: ChatGPTLoginStatus } = { outcome: { status: "pending" } };
    const { client } = automaticClient(finish);
    renderModels(client, { ...webPlatform, openExternal: vi.fn() });
    await openDialog();

    expect(await screen.findByText("Waiting for you to finish signing in in your browser…")).toBeDefined();
    expect(screen.queryByLabelText("Address from the browser")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Paste the address instead" }));
    expect(screen.getByLabelText("Address from the browser")).toBeDefined();

    const provider = await client.modelProviders.create({ kind: "builtin", providerId: "openai", apiKey: "sk-x" });
    finish.outcome = { status: "connected", provider };
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), { timeout: 4000 });
  });

  it("says in plain words why the engine refused, and cancels the login when closed", async () => {
    const finish: { outcome: ChatGPTLoginStatus } = { outcome: { status: "pending" } };
    const { client, cancelled } = automaticClient(finish);
    renderModels(client, { ...webPlatform, openExternal: vi.fn() });
    await openDialog();
    await screen.findByText("Waiting for you to finish signing in in your browser…");

    finish.outcome = { status: "failed", error: { code: "LOGIN_FAILED", message: "x" } };
    expect((await screen.findByRole("alert", {}, { timeout: 4000 })).textContent).toBe("OpenAI didn't accept this sign-in. Try again.");

    fireEvent.click(await screen.findByRole("button", { name: "Open ChatGPT sign-in" }));
    await screen.findByText("Waiting for you to finish signing in in your browser…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelled).toHaveLength(1));
  });
});

// The ui Combobox trigger is a role=combobox button with no label prop, so find it by its slot.
const modelPicker = () =>
  waitFor(() => {
    const trigger = document.querySelector<HTMLElement>('[data-slot="combobox-trigger"]');
    if (!trigger) throw new Error("model picker not rendered");
    return trigger;
  });

describe("default model", () => {
  it("saves provider, model and temperature", async () => {
    const client = createMockClient({ seed: 7, platformDefault: false });
    const openai = await client.modelProviders.create({ kind: "builtin", providerId: "openai", apiKey: "sk-x" });
    renderModels(client);

    await pickOption("Provider", openai.name);
    fireEvent.click(await modelPicker());
    fireEvent.click(await screen.findByRole("option", { name: /GPT-5\.5 mini/ }));
    typeInto(screen.getByLabelText("Temperature"), "0.3");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeDefined());
    expect((await client.settings.get()).models).toMatchObject({
      providerId: openai.id,
      defaultModel: "gpt-5.5-mini",
      temperature: 0.3,
    });
    expect(screen.queryByLabelText("Reasoning effort")).toBeNull();
  });

  it("says the default needs choosing when its provider no longer exists", async () => {
    const client = createMockClient({ seed: 7, platformDefault: false });
    const openai = await client.modelProviders.create({ kind: "builtin", providerId: "openai", apiKey: "sk-x" });
    await client.settings.update({ models: { providerId: openai.id, defaultModel: "gpt-5.5" } });
    await client.modelProviders.delete(openai.id);
    renderModels(client);
    expect(await screen.findByText(/no longer exists/)).toBeDefined();
  });
});

describe("background models", () => {
  it("adds a System One provider, picks it, and explains what Auto resolves to", async () => {
    const client = createMockClient({ seed: 7, platformDefault: false });
    await client.modelProviders.create({ kind: "builtin", providerId: "anthropic", apiKey: "sk-x" });
    renderModels(client);

    // System One falls back to the quick-jobs model until one is picked.
    expect(await screen.findByText(/your fast model stands in/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.click(await screen.findByText("System One endpoint"));
    typeInto(screen.getByLabelText("Name"), "TypeSafe");
    typeInto(screen.getByLabelText("Base URL"), "https://api.typesafe.ai");
    typeInto(screen.getByLabelText("Model ids"), "jev-latest, jev-fast");
    typeInto(screen.getByLabelText("API key"), "ts-secret");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add provider" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain("ts-secret");

    const triggers = () => document.querySelectorAll<HTMLElement>('[data-slot="combobox-trigger"]');
    await waitFor(() => expect(triggers().length).toBeGreaterThan(1));
    fireEvent.click(triggers()[triggers().length - 1]!);
    fireEvent.click(await screen.findByText("jev-fast"));
    await waitFor(async () =>
      expect((await client.settings.get()).models?.systemOneModel).toMatchObject({ modelId: "jev-fast" }),
    );
    // The System One provider never shows up among the agent model's providers.
    expect([...(screen.queryByLabelText("Provider") as HTMLSelectElement | null)?.options ?? []].map((o) => o.text)).not.toContain("TypeSafe");
  });

});

describe("what each job runs on", () => {
  const openRow = async (name: string) => fireEvent.click(await screen.findByRole("button", { name: `Change ${name}` }));
  const dialogPicker = () => screen.getByRole("dialog").querySelector<HTMLElement>('[data-slot="combobox-trigger"]')!;

  it("shows the four jobs in order with their current model and level", async () => {
    const client = createMockClient({ seed: 7, platformDefault: true });
    await client.settings.update({ models: { tiers: { deep: { modelId: "mock-main", effort: "high" } } } });
    renderModels(client);

    const rows = await Promise.all(["Chat", "Tasks", "Hard problems", "Quick jobs"].map((name) => screen.findByRole("button", { name: `Change ${name}` })));
    // The names arrive with the catalogs, so wait for them rather than the raw ids.
    await waitFor(() =>
      expect(rows.map((row) => row.textContent)).toEqual(["Mock MainDefault", "Mock MainDefault", "Mock Main · high", "Mock FastDefault"]),
    );
  });

  it("offers only the chosen model's levels and sends every kept row in one patch", async () => {
    const client = createMockClient({ seed: 7, platformDefault: true });
    await client.settings.update({ models: { tiers: { task: { modelId: "mock-fast" } } } });
    const update = vi.spyOn(client.settings, "update");
    renderModels(client);

    await openRow("Chat");
    fireEvent.click(dialogPicker());
    fireEvent.click(await screen.findByRole("option", { name: /Mock Main/ }));
    fireEvent.keyDown(screen.getByLabelText("Thinking level"), { key: "Enter" });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Default", "low", "medium", "high"]);
    fireEvent.click(screen.getByRole("option", { name: "medium" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenLastCalledWith({
      models: { tiers: { task: { modelId: "mock-fast" }, chat: { modelId: "mock-main", effort: "medium" } } },
    });
    expect((await screen.findByRole("button", { name: "Change Chat" })).textContent).toBe("Mock Main · medium");
  });

  it("keeps the quick jobs level disabled until a model is chosen, and resets a row", async () => {
    const client = createMockClient({ seed: 7, platformDefault: true });
    await client.settings.update({ models: { tiers: { chat: { modelId: "mock-main" }, fast: { modelId: "mock-main", effort: "low" } } } });
    const update = vi.spyOn(client.settings, "update");
    renderModels(client);

    await openRow("Quick jobs");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(update).toHaveBeenLastCalledWith({ models: { tiers: { chat: { modelId: "mock-main" } } } });

    await openRow("Quick jobs");
    expect(screen.getByLabelText("Thinking level").hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Pick a model first to choose a level for quick jobs.")).toBeDefined();
  });

  it("says in plain words why the server refused", async () => {
    const client = createMockClient({ seed: 7, platformDefault: true });
    client.settings.update = async () => {
      throw Object.assign(new Error("no"), { status: 400, code: "UNSUPPORTED_EFFORT" });
    };
    renderModels(client);
    await openRow("Chat");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That model doesn't offer this thinking level. Pick another level.");
  });
});
