import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import config from "../vite.config.ts";
import { resolveWebServerSettings } from "../src/server-settings.ts";

const defaults = { serverUrl: "http://127.0.0.1:8787", apiToken: "fixture-token" };
test("unconfigured web follows local or forwarded origin; explicit servers stay intact", () => {
  for (const origin of ["https://forwarded-5199.asse.devtunnels.ms", "http://localhost:5199"]) {
    assert.deepEqual(resolveWebServerSettings(defaults, false, origin), { ...defaults, serverUrl: origin });
    assert.deepEqual(resolveWebServerSettings(defaults, true, origin), defaults);
    const custom = { ...defaults, serverUrl: "https://custom.example" };
    assert.deepEqual(resolveWebServerSettings(custom, true, origin), custom);
    assert.equal(resolveWebServerSettings(custom, false, origin).serverUrl, origin);
    assert.deepEqual(defaults, { serverUrl: "http://127.0.0.1:8787", apiToken: "fixture-token" });
  }
});

test("the web entry no longer honours a demo/mock bypass", () => {
  const main = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
  assert.ok(!/mock/i.test(main), "web bootstrap must not activate a demo/mock client");
});

test("proxy targets only local agentd, leaves Origin/cookies/auth intact, and supports WS/SSE", () => {
  const proxies = config.server?.proxy;
  assert.ok(proxies);
  for (const path of ["/auth", "/v1", "/healthz"]) {
    const options = proxies[path];
    assert.ok(options && typeof options !== "string");
    assert.equal(options.target, "http://127.0.0.1:8787");
    assert.equal(options.changeOrigin, false);
    assert.equal(options.headers, undefined);
    assert.equal(options.auth, undefined);
    assert.equal(options.configure, undefined);
    assert.equal(options.cookieDomainRewrite, undefined);
    assert.equal(options.cookiePathRewrite, undefined);
    assert.equal(options.selfHandleResponse, undefined); // http-proxy pipes streaming responses.
    assert.equal(options.timeout, undefined); // no idle cutoff for a quiet SSE stream.
    if (path !== "/healthz") {
      assert.equal(options.ws, true);
      assert.equal(options.rewriteWsOrigin, false);
    }
  }
});
