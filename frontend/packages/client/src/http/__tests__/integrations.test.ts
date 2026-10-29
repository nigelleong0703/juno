import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "../client.js";

const ISO = "2026-10-07T00:00:00.000Z";

const PLUGIN = {
  id: "plugin-linear",
  name: "Linear",
  publisher: "Linear",
  category: "Productivity",
  description: "Issues and projects",
  icon: "linear",
  installed: false,
  featured: false,
  tools: [
    {
      id: "tool-search",
      pluginId: "plugin-linear",
      name: "search_issues",
      description: "Search issues",
      permission: "ask",
    },
  ],
  accounts: [],
  usedByAgentIds: [],
};

const APP = {
  id: "hevy",
  name: "Hevy",
  category: "work",
  source: "official",
  group: "health",
  icon: "hevy",
  blurb: "Workouts",
  description: "Your workout log",
  tryAsking: ["What did I lift last week?"],
  auth: "api_key",
  available: true,
  userConfig: [
    { key: "api_key", type: "string", title: "API key", description: "From the Hevy app", required: true, sensitive: true },
  ],
  version: 1,
  grants: { chatRead: true, actions: true },
  installations: [],
  enabledAgents: [],
};

interface SeenCall {
  url: string;
  init: RequestInit;
}

type Route = { method: string; path: string; status: number; body: unknown };

function clientFor(seen: SeenCall[], routes: Route[], token = "tok") {
  const fetch = async (url: unknown, init?: unknown) => {
    const request = (init ?? {}) as RequestInit;
    seen.push({ url: String(url), init: request });
    const parsed = new URL(String(url));
    const route = routes.find(
      (entry) => entry.method === request.method && entry.path === parsed.pathname,
    );
    if (!route) {
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(route.status === 204 ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  };
  return createHttpClient({
    baseUrl: "http://api.test",
    getToken: () => token,
    fetch: vi.fn(fetch),
  });
}

function authHeader(call: SeenCall): string | null {
  const headers = new Headers(call.init.headers);
  return headers.get("authorization");
}

interface HttpFailure {
  status: number;
  code: string;
  message: string;
}

async function captureFailure(task: Promise<unknown>): Promise<HttpFailure | null> {
  try {
    await task;
    return null;
  } catch (error: unknown) {
    if (typeof error !== "object" || error === null) return null;
    const record = error as Record<string, unknown>;
    if (typeof record.status !== "number") return null;
    if (typeof record.code !== "string" || typeof record.message !== "string") return null;
    return { status: record.status, code: record.code, message: record.message };
  }
}

describe("plugins HTTP boundary", () => {
  it("lists plugins with category, installed, and pagination params", async () => {
    const seen: SeenCall[] = [];
    const client = clientFor(seen, [
      {
        method: "GET",
        path: "/v1/plugins",
        status: 200,
        body: { items: [PLUGIN], nextCursor: "cursor-2" },
      },
    ]);
    const result = await client.plugins.list({
      category: "Productivity",
      installed: false,
      limit: 25,
      cursor: "cursor-1",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe("plugin-linear");
    expect(result.nextCursor).toBe("cursor-2");
    const call = seen[0] as SeenCall;
    expect(call.init.method).toBe("GET");
    const url = new URL(call.url);
    expect(url.pathname).toBe("/v1/plugins");
    expect(url.searchParams.get("category")).toBe("Productivity");
    expect(url.searchParams.get("installed")).toBe("false");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
    expect(authHeader(call)).toBe("Bearer tok");
  });

  it("treats an empty plugin catalog as a valid empty page", async () => {
    const seen: SeenCall[] = [];
    const client = clientFor(seen, [
      { method: "GET", path: "/v1/plugins", status: 200, body: { items: [], nextCursor: null } },
    ]);
    const result = await client.plugins.list();
    expect(result).toEqual({ items: [], nextCursor: null });
    expect(seen).toHaveLength(1);
  });

  it("gets one plugin by id", async () => {
    const seen: SeenCall[] = [];
    const client = clientFor(seen, [
      { method: "GET", path: "/v1/plugins/plugin-linear", status: 200, body: PLUGIN },
    ]);
    const plugin = await client.plugins.get("plugin-linear");
    expect(plugin.id).toBe("plugin-linear");
    const call = seen[0] as SeenCall;
    expect(new URL(call.url).pathname).toBe("/v1/plugins/plugin-linear");
    expect(call.init.method).toBe("GET");
  });

  it("installs and uninstalls through the exact nested paths", async () => {
    const seen: SeenCall[] = [];
    const installed = { ...PLUGIN, installed: true };
    const client = clientFor(seen, [
      { method: "POST", path: "/v1/plugins/plugin-linear/install", status: 200, body: installed },
      { method: "POST", path: "/v1/plugins/plugin-linear/uninstall", status: 200, body: PLUGIN },
    ]);
    const afterInstall = await client.plugins.install("plugin-linear");
    expect(afterInstall.installed).toBe(true);
    const afterUninstall = await client.plugins.uninstall("plugin-linear");
    expect(afterUninstall.installed).toBe(false);
    expect(seen.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/plugins/plugin-linear/install",
      "/v1/plugins/plugin-linear/uninstall",
    ]);
    expect(seen.every((call) => call.init.method === "POST")).toBe(true);
  });

  it("posts tool permission changes with the exact body", async () => {
    const seen: SeenCall[] = [];
    const updated = {
      ...PLUGIN,
      tools: [{ ...PLUGIN.tools[0], permission: "always" }],
    };
    const client = clientFor(seen, [
      { method: "POST", path: "/v1/plugins/tool-permission", status: 200, body: updated },
    ]);
    const plugin = await client.plugins.setToolPermission({
      pluginId: "plugin-linear",
      toolId: "tool-search",
      permission: "always",
    });
    expect(plugin.tools[0]?.permission).toBe("always");
    const call = seen[0] as SeenCall;
    expect(new URL(call.url).pathname).toBe("/v1/plugins/tool-permission");
    expect(JSON.parse(String(call.init.body))).toEqual({
      pluginId: "plugin-linear",
      toolId: "tool-search",
      permission: "always",
    });
  });

  it("reads secret metadata without ever receiving values", async () => {
    const seen: SeenCall[] = [];
    const client = clientFor(seen, [
      {
        method: "GET",
        path: "/v1/plugins/secrets",
        status: 200,
        body: [
          {
            id: "secret-1",
            name: "Model provider key",
            scope: "personal",
            source: "manual",
            updatedAt: ISO,
          },
        ],
      },
    ]);
    const secrets = await client.plugins.secrets();
    expect(secrets).toHaveLength(1);
    expect(secrets[0]).not.toHaveProperty("value");
    expect(new URL((seen[0] as SeenCall).url).pathname).toBe("/v1/plugins/secrets");
  });

  it("maps a missing plugin to a 404 error with its code", async () => {
    const seen: SeenCall[] = [];
    const client = clientFor(seen, [
      {
        method: "GET",
        path: "/v1/plugins/nope",
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "plugins nope not found" } },
      },
    ]);
    const failure = await captureFailure(client.plugins.get("nope"));
    expect(failure?.status).toBe(404);
    expect(failure?.code).toBe("NOT_FOUND");
    expect(failure?.message).toContain("plugins nope not found");
    expect(seen).toHaveLength(1);
  });
});

describe("apps HTTP boundary", () => {
  it("lists the apps from the items wrapper and reads one with its capabilities", async () => {
    const seen: SeenCall[] = [];
    const detail = {
      ...APP,
      capabilities: [{ name: "list_workouts", title: "See your workouts", kind: "read" }],
      pending: [],
      skills: [{ name: "log", description: "How to log a workout", onboarding: true }],
    };
    const client = clientFor(seen, [
      { method: "GET", path: "/v1/apps", status: 200, body: { items: [APP] } },
      { method: "GET", path: "/v1/apps/hevy", status: 200, body: detail },
    ]);
    expect((await client.apps.list())[0]?.name).toBe("Hevy");
    const got = await client.apps.get("hevy");
    expect(got.capabilities[0]?.kind).toBe("read");
    expect(got.skills[0]?.onboarding).toBe(true);
    expect(seen.map((call) => new URL(call.url).pathname)).toEqual(["/v1/apps", "/v1/apps/hevy"]);
  });

  it("installs with the declared values and returns what to open", async () => {
    const seen: SeenCall[] = [];
    const client = clientFor(seen, [
      {
        method: "POST",
        path: "/v1/apps/gmail/install",
        status: 201,
        body: { appId: "gmail", installation: null, pending: null, openUrl: "https://accounts.example/auth" },
      },
      {
        method: "POST",
        path: "/v1/apps/hevy/install",
        status: 400,
        body: { error: { code: "CONNECTOR_CONFIG_REQUIRED", message: "api_key is required" } },
      },
    ]);
    const signIn = await client.apps.install("gmail", { returnUrl: "https://app.test/apps/gmail" });
    expect(signIn.openUrl).toBe("https://accounts.example/auth");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ returnUrl: "https://app.test/apps/gmail" });
    const failure = await captureFailure(client.apps.install("hevy"));
    expect(failure?.status).toBe(400);
    expect(failure?.code).toBe("CONNECTOR_CONFIG_REQUIRED");
  });

  it("probes a custom server by address and sends the person's confirmation with the install", async () => {
    const seen: SeenCall[] = [];
    const probe = { url: "https://mcp.example.com/mcp", auth: "none", usable: true, tools: [{ name: "sync", title: "Sync", suggested: "change", basis: "unmarked" }] };
    const client = clientFor(seen, [
      { method: "POST", path: "/v1/apps/custom/probe", status: 200, body: probe },
      { method: "POST", path: "/v1/apps/custom/install", status: 409, body: { error: { code: "CUSTOM_PROBE_CHANGED", message: "The server now asks for something different." } } },
    ]);
    expect((await client.apps.probeCustom(probe.url)).tools?.[0]?.suggested).toBe("change");
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ url: probe.url });
    const confirm = { auth: "none" as const, tools: { sync: "read" as const } };
    const failure = await captureFailure(client.apps.install("custom", { name: "Docs", transport: "http", url: probe.url, confirm }));
    expect(failure?.code).toBe("CUSTOM_PROBE_CHANGED");
    expect(JSON.parse(String(seen[1]?.init.body))).toMatchObject({ confirm });
  });

  it("removes an installation, sets an agent's switch and a workspace agent through the exact paths", async () => {
    const seen: SeenCall[] = [];
    const client = clientFor(seen, [
      { method: "DELETE", path: "/v1/apps/slack/installations/inst%201", status: 204, body: null },
      {
        method: "PUT",
        path: "/v1/agents/a1/apps/hevy",
        status: 200,
        body: { agentId: "a1", appId: "hevy", enabled: true, actionsPolicy: "allow" },
      },
      {
        method: "PUT",
        path: "/v1/apps/slack/installations/inst1/agents/a1",
        status: 200,
        body: { items: [{ agentId: "a1", handle: "nova" }] },
      },
    ]);
    await client.apps.removeInstallation("slack", "inst 1");
    const row = await client.apps.setAgentApp("a1", "hevy", { enabled: true, actionsPolicy: "allow" });
    expect(row.actionsPolicy).toBe("allow");
    expect(JSON.parse(String(seen[1]?.init.body))).toEqual({ enabled: true, actionsPolicy: "allow" });
    const agents = await client.apps.setWorkspaceAgent("slack", "inst1", "a1", { enabled: true });
    expect(agents[0]?.handle).toBe("nova");
    expect(seen.map((call) => call.init.method)).toEqual(["DELETE", "PUT", "PUT"]);
  });
});
