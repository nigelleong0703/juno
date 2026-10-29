import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildContentSecurityPolicy,
  normalizeServerOrigin,
  normalizeWebSocketOrigin,
  registerServerOrigin,
  requireAllowedServerOrigin,
} from "./server-origin";

const DEFAULT = "http://127.0.0.1:8787";

function connectSources(csp: string): string[] {
  const match = /connect-src ([^;]+)/.exec(csp);
  return (match?.[1] ?? "").split(/\s+/).filter(Boolean);
}

describe("normalizeServerOrigin", () => {
  it("keeps the origin and drops path, query and fragment", () => {
    expect(normalizeServerOrigin("https://box.example:9000/v1?x=1#f")).toBe(
      "https://box.example:9000",
    );
    expect(normalizeServerOrigin(DEFAULT)).toBe(DEFAULT);
    expect(normalizeServerOrigin("http://localhost:5199/")).toBe("http://localhost:5199");
  });

  it("refuses anything that is not a plain http(s) server origin", () => {
    const rejected = [
      "",
      "localhost:8787",
      "ws://127.0.0.1:8787",
      "wss://box.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://host",
      "http://user:pw@host",
      "https://*.example.com",
      "http://*",
      "https://a.*.example.com",
      "not a url",
    ];
    for (const value of rejected) {
      expect(normalizeServerOrigin(value)).toBeNull();
    }
  });
});

describe("registerServerOrigin (the IPC trust boundary)", () => {
  it("validates and reports whether the origin is new", () => {
    const known = new Set([DEFAULT]);
    expect(registerServerOrigin(known, DEFAULT)).toEqual({ origin: DEFAULT, changed: false });
    expect(registerServerOrigin(known, "https://box.example:9000/api")).toEqual({
      origin: "https://box.example:9000",
      changed: true,
    });
  });

  it("ignores non-string and non-http(s) values", () => {
    const known = new Set([DEFAULT]);
    expect(registerServerOrigin(known, 42)).toEqual({ origin: null, changed: false });
    expect(registerServerOrigin(known, undefined)).toEqual({ origin: null, changed: false });
    expect(registerServerOrigin(known, "file:///etc/passwd")).toEqual({
      origin: null,
      changed: false,
    });
  });
});

describe("normalizeWebSocketOrigin", () => {
  it("accepts explicit ws/wss URLs and nothing else", () => {
    expect(normalizeWebSocketOrigin("ws://127.0.0.1:9001/stream")).toBe("ws://127.0.0.1:9001");
    expect(normalizeWebSocketOrigin("wss://stream.example")).toBe("wss://stream.example");
    for (const value of [
      "*",
      "http:",
      "https:",
      "http://x",
      "evil",
      "ws://user:pw@host",
      "ws://*.example.com",
      "",
    ]) {
      expect(normalizeWebSocketOrigin(value)).toBeNull();
    }
  });
});

describe("requireAllowedServerOrigin (desktop must not mimic the web no-op)", () => {
  it("passes a well-formed allowance through", () => {
    expect(requireAllowedServerOrigin({ origin: DEFAULT, reloadRequired: false })).toEqual({
      origin: DEFAULT,
      reloadRequired: false,
    });
  });

  it("throws on a null or malformed result instead of letting the app go ready", () => {
    expect(() => requireAllowedServerOrigin(null)).toThrow(/rejected/);
    expect(() => requireAllowedServerOrigin({ origin: null, reloadRequired: false })).toThrow();
    expect(() => requireAllowedServerOrigin({ origin: "https://x" })).toThrow();
    expect(() => requireAllowedServerOrigin("nope")).toThrow();
  });

  it("never echoes the requested value in the error", () => {
    let caught: unknown = null;
    try {
      requireAllowedServerOrigin(null);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toBe("Desktop shell rejected the server origin");
  });
});

describe("preload origin IPC", () => {
  const preload = readFileSync(new URL("../preload/index.ts", import.meta.url), "utf8");

  it("routes the IPC result through the throwing validator", () => {
    expect(preload).toContain("requireAllowedServerOrigin");
  });
});

describe("buildContentSecurityPolicy", () => {
  it("allows only 'self' plus host-specific origins — never a bare scheme or wildcard", () => {
    const csp = buildContentSecurityPolicy({
      serverOrigins: [DEFAULT, "https://box.example:9000"],
      streamOrigins: [],
      devOrigins: [],
    });
    const connect = connectSources(csp);

    expect(connect).toContain("'self'");
    expect(connect).toContain(DEFAULT);
    expect(connect).toContain("ws://127.0.0.1:8787");
    expect(connect).toContain("https://box.example:9000");
    expect(connect).toContain("wss://box.example:9000");
    expect(connect).not.toContain("http:");
    expect(connect).not.toContain("https:");
    expect(connect).not.toContain("*");
  });

  it("keeps the default, adds stream origins and skips invalid entries", () => {
    const csp = buildContentSecurityPolicy({
      serverOrigins: [DEFAULT, "javascript:alert(1)"],
      streamOrigins: ["ws://127.0.0.1:9001"],
      devOrigins: [],
    });
    const connect = connectSources(csp);

    expect(connect).toContain(DEFAULT);
    expect(connect).toContain("ws://127.0.0.1:9001");
    expect(connect.some((entry) => entry.startsWith("javascript:"))).toBe(false);
  });

  it("drops stream origins that are not explicit ws/wss URLs", () => {
    const csp = buildContentSecurityPolicy({
      serverOrigins: [DEFAULT],
      streamOrigins: ["*", "http:", "https:", "evil", "ws://127.0.0.1:9001", "wss://stream.example"],
      devOrigins: [],
    });
    const connect = connectSources(csp);

    expect(connect).toContain("ws://127.0.0.1:9001");
    expect(connect).toContain("wss://stream.example");
    expect(connect).not.toContain("*");
    expect(connect).not.toContain("http:");
    expect(connect).not.toContain("https:");
    expect(connect).not.toContain("evil");
  });

  it("never emits a wildcard hostname that WHATWG URL accepts", () => {
    const csp = buildContentSecurityPolicy({
      serverOrigins: [DEFAULT, "https://*.example.com", "http://*"],
      streamOrigins: ["ws://*.example.com"],
      devOrigins: [],
    });
    const connect = connectSources(csp);

    expect(connect).toContain(DEFAULT);
    expect(connect.some((entry) => entry.includes("*"))).toBe(false);
  });

  it("adds the Vite dev origins only when provided", () => {
    const dev = buildContentSecurityPolicy({
      serverOrigins: [DEFAULT],
      streamOrigins: [],
      devOrigins: ["http://localhost:5199", "ws://localhost:5199"],
    });
    expect(connectSources(dev)).toContain("http://localhost:5199");
    expect(dev).toMatch(/script-src[^;]*'unsafe-inline'/);

    const packaged = buildContentSecurityPolicy({
      serverOrigins: [DEFAULT],
      streamOrigins: [],
      devOrigins: [],
    });
    expect(connectSources(packaged)).not.toContain("http://localhost:5199");
  });
});

describe("packaged main wiring", () => {
  const main = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("always allows the documented default server", () => {
    expect(main).toContain(DEFAULT);
    expect(main).not.toMatch(
      /SERVER_ORIGIN\s*=\s*process\.env\.AGENT_DESKTOP_SERVER_ORIGIN\s*\?\?\s*["']{2}/,
    );
  });

  it("retains the Electron security posture", () => {
    expect(main).toMatch(/webSecurity:\s*true/);
    expect(main).toMatch(/contextIsolation:\s*true/);
    expect(main).toMatch(/sandbox:\s*true/);
  });

  it("never rewrites the current document's CSP in place (the reload is renderer-driven)", () => {
    expect(main).not.toContain("webContents.reload");
    expect(main).toContain("reloadRequired");
  });
  it("re-checks asset confinement after resolving symlinks", () => {
    expect(main).toContain("realpath");
    expect(main).toContain("isAssetPathConfined");
  });
});

describe("renderer bootstrap sequencing (delegated to shared AccountGate)", () => {
  const renderer = readFileSync(new URL("../renderer/src/main.tsx", import.meta.url), "utf8");
  const gate = readFileSync(new URL("../../../app/src/components/AccountGate.tsx", import.meta.url), "utf8");
  const connectivity = readFileSync(new URL("../../../app/src/platform/connectivity.ts", import.meta.url), "utf8");

  it("delegates bootstrap to the shared gate with the native platform bridge", () => {
    expect(renderer).toContain("<AccountGate");
    expect(renderer).toContain("platform={window.platform}");
    expect(renderer).toContain("renderApp=");
    expect(renderer).toContain("DesktopBridge");
    expect(renderer).not.toContain("createServerConnectivityResolver");
  });

  it("registers the server origin before any auth or domain request", () => {
    expect(connectivity).toContain("platform.allowServerOrigin");
    expect(gate).toContain("await connectivity(settings)");
    expect(gate).toContain("await discoverAuthInfo");
    const register = gate.indexOf("await connectivity(settings)");
    const auth = gate.indexOf("await discoverAuthInfo");
    expect(register).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(register);
  });

  it("reloads for a changed origin instead of fetching against a stale CSP", () => {
    expect(gate).toContain('step.kind === "reload"');
    expect(gate).toContain("window.location.reload()");
    const reload = gate.indexOf("window.location.reload()");
    const auth = gate.indexOf("await discoverAuthInfo");
    expect(reload).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(reload);
  });

  it("surfaces bootstrap failures instead of mounting the app", () => {
    expect(gate).toContain('kind: "error"');
    expect(gate).toContain("Could not connect");
    expect(gate).toContain('state.kind === "ready"');
  });
});
