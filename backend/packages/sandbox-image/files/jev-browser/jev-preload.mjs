// Preload for original jev-browser MCP under trusted root supervision.
// Connection and upload-permission seams only. No decision, threshold, retry or prompt changes.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { posix } from "node:path";
const agentUser = process.env.JUNO_JEV_AGENT_USER || "";
function refuse(reason) { throw new Error("upload refused: " + reason); }
function realpathOf(path) {
  try { return realpathSync(path); } catch { return refuse("unreadable path"); }
}
function denyPrefix(real) {
  const blocked = ["/root", "/etc/juno", "/run", "/proc", "/sys", "/dev"];
  for (const prefix of blocked) { if (real === prefix || real.indexOf(prefix + "/") === 0) return true; }
  return false;
}
function readableAsAgent(real) {
  if (!agentUser) return false;
  const probed = spawnSync("runuser", ["-u", agentUser, "--", "test", "-r", real]);
  return probed.status === 0;
}
function agentBytes(real) {
  const cat = spawnSync("runuser", ["-u", agentUser, "--", "cat", real], { maxBuffer: 64 * 1024 * 1024 });
  if (cat.status !== 0 || !Buffer.isBuffer(cat.stdout)) refuse("unreadable path");
  return cat.stdout;
}
function basenameOf(path) {
  return posix.basename(path) || "upload";
}
function gateUploadFile(path) {
  if (typeof path !== "string" || path === "" || path.indexOf("/") !== 0) refuse("unreadable path");
  const real = realpathOf(path);
  if (denyPrefix(real)) refuse("root or foreign path");
  if (real.indexOf("/home/") === 0) {
    const parts = real.split("/");
    const homeUser = parts[2] || "";
    if (homeUser !== agentUser) refuse("foreign home");
  }
  if (!readableAsAgent(real)) refuse("root or foreign path");
  const buffer = agentBytes(real);
  return { name: basenameOf(path), mimeType: "application/octet-stream", buffer: buffer };
}
function gateUploadInput(files) {
  if (typeof files === "string") return gateUploadFile(files);
  if (Array.isArray(files)) return files.map((entry) => {
    if (typeof entry !== "string") refuse("invalid upload path");
    return gateUploadFile(entry);
  });
  refuse("invalid upload path");
}
const upstreamRoot = "/opt/juno/jev-browser/upstream";
const sessionModule = await import(upstreamRoot + "/src/session.mjs");
const chromiumModule = await import(upstreamRoot + "/node_modules/playwright/index.mjs");
const sdkModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
const zodModule = await import("zod");
const JevBrowser = sessionModule.JevBrowser;
const chromium = chromiumModule.chromium;
const McpServer = sdkModule.McpServer;
const z = zodModule.z;
let capturedServer = null;
const originalConnect = McpServer.prototype.connect;
McpServer.prototype.connect = async function (transport) {
  // eslint-disable-next-line @typescript-eslint/no-this-alias -- capture the original McpServer for its private request channel
  capturedServer = this;
  return originalConnect.call(this, transport);
};
const relayReplySchema = z.object({ status: z.number(), body: z.unknown() });
function isSystemOneRequest(url, init) {
  if (typeof url !== "string") return false;
  if (url.indexOf("/v1/systemone") < 0) return false;
  const method = init && init.method ? String(init.method).toUpperCase() : "GET";
  return method === "POST";
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (url, init) {
  if (!isSystemOneRequest(url, init)) return originalFetch(url, init);
  if (!capturedServer) throw new Error("relay unavailable");
  let payload;
  try { payload = JSON.parse(String(init.body)); } catch { throw new Error("relay: invalid request body"); }
  const outcome = await capturedServer.server.request({ method: "juno/jev", params: { state: payload.state, questions: payload.questions } }, relayReplySchema);
  return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { "content-type": "application/json" } });
};
function readCdpEndpoint() {
  const explicit = process.env.JUNO_JEV_CDP;
  if (typeof explicit !== "string" || explicit === "") return null;
  let parsed;
  try { parsed = new URL(explicit); } catch { return null; }
  if (parsed.protocol !== "http:") return null;
  if (parsed.hostname !== "127.0.0.1") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return "http://127.0.0.1:" + String(port);
}
async function pickActivePage(context) {
  const pages = context.pages();
  if (pages.length === 0) return context.newPage();
  for (const page of pages) {
    let state;
    try { state = await page.evaluate("document.visibilityState"); } catch { state = ""; }
    if (state === "visible") return page;
  }
  return pages[pages.length - 1];
}
JevBrowser.launch = async function () {
  const endpoint = readCdpEndpoint();
  if (!endpoint) throw new Error("no live Chromium for this agent");
  const browser = await chromium.connectOverCDP(endpoint);
  const contexts = browser.contexts();
  if (contexts.length === 0) throw new Error("existing Chromium has no context");
  const context = contexts[0];
  const session = new JevBrowser(browser, context, false);
  session.page = await pickActivePage(context);
  session.__junoAttached = true;
  return session;
};
const originalClose = JevBrowser.prototype.close;
JevBrowser.prototype.close = async function () {
  if (this.__junoAttached) {
    try { if (this.browser) await this.browser.close(); } catch { void 0; }
    return;
  }
  return originalClose.call(this);
};
if (typeof JevBrowser.prototype.snapshot !== "function") throw new Error("snapshot redaction seam unavailable");
const originalSnapshot = JevBrowser.prototype.snapshot;
JevBrowser.prototype.snapshot = async function (...args) {
  const page = await originalSnapshot.apply(this, args);
  const endpoint = readCdpEndpoint();
  const port = endpoint === null ? "" : new URL(endpoint).port;
  if (port === "") throw new Error("secure snapshot redaction unavailable");
  let input;
  try {
    input = JSON.stringify(page);
  } catch {
    throw new Error("secure snapshot serialization failed");
  }
  const redacted = spawnSync(
    "/usr/bin/python3",
    ["/opt/juno/jev-browser/jev_redact.py", port],
    { input: input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (redacted.status !== 0 || typeof redacted.stdout !== "string" || redacted.stdout === "") {
    throw new Error("secure snapshot redaction unavailable");
  }
  try {
    return JSON.parse(redacted.stdout);
  } catch {
    throw new Error("secure snapshot redaction returned invalid data");
  }
};
if (typeof JevBrowser.prototype.locate !== "function") throw new Error("upload gate unavailable");
const originalLocate = JevBrowser.prototype.locate;
JevBrowser.prototype.locate = function (target) {
  const loc = originalLocate.call(this, target);
  if (loc && !loc.__junoUploadGated && typeof loc.setInputFiles === "function") {
    const originalSet = loc.setInputFiles.bind(loc);
    loc.setInputFiles = function (files, options) { return originalSet(gateUploadInput(files), options); };
    loc.__junoUploadGated = true;
  }
  return loc;
};
