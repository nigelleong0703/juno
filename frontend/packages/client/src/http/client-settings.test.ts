import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./client.js";

const SETTINGS = {
  general: { launchAtLogin: false, language: "en" },
  appearance: { theme: "dark", density: "comfortable", accent: "violet" },
  notifications: [],
  yourComputer: { allowLocalAccess: false, folders: [], permissionsStatus: "not_requested" },
  connections: { serverUrl: "http://127.0.0.1:8787", modelProviders: [] },
  privacy: { dataRetentionDays: 30, trainingOptIn: false },
  advanced: { releaseTrack: "stable", logsEnabled: false, networkDebugger: false },
  effectiveTiers: {
    chat: { providerId: null, modelId: "model-a", effort: null, source: "default" },
    task: { providerId: null, modelId: "model-a", effort: "none", source: "default" },
    deep: { providerId: null, modelId: "model-b", effort: "high", source: "chosen" },
    fast: null,
  },
  effectiveSystemOneModel: null,
};

const CATALOG = {
  defaultModel: "model-a",
  items: [
    { id: "model-a", name: "Model A", supportsImages: true },
    { id: "model-b", name: "Model B", supportsImages: false },
  ],
};

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeFetch(routes: Record<string, unknown>, seen: Seen[]) {
  return vi.fn(async (url: unknown, init?: RequestInit) => {
    const raw = String(url);
    const path = new URL(raw).pathname;
    seen.push({
      url: raw,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(routes[path]), {
      headers: { "content-type": "application/json" },
    });
  });
}
describe("settings transport", () => {
  it("gets settings with bearer auth", async () => {
    const seen: Seen[] = [];
    const client = createHttpClient({
      baseUrl: "http://api.test",
      getToken: () => "tok",
      fetch: fakeFetch({ "/v1/settings": SETTINGS }, seen),
    });
    const settings = await client.settings.get();
    expect(settings.appearance.theme).toBe("dark");
    expect(settings.effectiveTiers?.deep).toEqual({ providerId: null, modelId: "model-b", effort: "high", source: "chosen" });
    expect(settings.effectiveTiers?.fast).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://api.test/v1/settings");
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers["authorization"]).toBe("Bearer tok");
  });

  it("patches settings models without touching siblings", async () => {
    const seen: Seen[] = [];
    const client = createHttpClient({
      baseUrl: "http://api.test",
      getToken: () => "tok",
      fetch: fakeFetch({ "/v1/settings": { ...SETTINGS, models: { defaultModel: "model-b" } } }, seen),
    });
    const updated = await client.settings.update({ models: { defaultModel: "model-b" } });
    expect(updated.models?.defaultModel).toBe("model-b");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("PATCH");
    expect(seen[0]?.body).toEqual({ models: { defaultModel: "model-b" } });
  });

  it("sends the whole tiers object in one patch", async () => {
    const seen: Seen[] = [];
    const tiers = { chat: { modelId: "model-a", effort: "low" }, fast: { providerId: "p1", modelId: "model-b" } } as const;
    const client = createHttpClient({
      baseUrl: "http://api.test",
      getToken: () => "tok",
      fetch: fakeFetch({ "/v1/settings": { ...SETTINGS, models: { defaultModel: null, tiers } } }, seen),
    });
    const updated = await client.settings.update({ models: { tiers } });
    expect(updated.models?.tiers).toEqual(tiers);
    expect(seen[0]?.body).toEqual({ models: { tiers } });
  });

  it("loads the model catalog with schema validation", async () => {
    const seen: Seen[] = [];
    const client = createHttpClient({
      baseUrl: "http://api.test",
      getToken: () => "tok",
      fetch: fakeFetch({ "/v1/models": CATALOG }, seen),
    });
    const catalog = await client.settings.models();
    expect(catalog.defaultModel).toBe("model-a");
    expect(catalog.items.map((item) => item.id)).toEqual(["model-a", "model-b"]);
    expect(seen[0]?.url).toBe("http://api.test/v1/models");
  });

  it("rejects a drifted catalog instead of rendering it", async () => {
    const client = createHttpClient({
      baseUrl: "http://api.test",
      getToken: () => "tok",
      fetch: fakeFetch({ "/v1/models": { defaultModel: "model-a", items: [{ id: "x" }] } }, []),
    });
    await expect(client.settings.models()).rejects.toThrow();
  });

  it("works without a token for the harness", async () => {
    const client = createHttpClient({
      baseUrl: "http://api.test",
      fetch: fakeFetch({ "/v1/settings": SETTINGS }, []),
    });
    const settings = await client.settings.get();
    expect(settings.general.language).toBe("en");
  });
});
