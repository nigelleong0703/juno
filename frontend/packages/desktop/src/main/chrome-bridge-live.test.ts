import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChromeBridge, type ChromeBridge } from "./chrome-bridge";
import { CHROME_EXTENSION_ID } from "./chrome-bridge-protocol";

const chromeExecutable = process.env.JUNO_CHROME_EXECUTABLE
  ?? join(homedir(), "Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
const live = process.env.JUNO_CHROME_LIVE === "1" && existsSync(chromeExecutable);

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

class CdpConnection {
  private nextId = 1;
  private waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id === undefined) return;
      const waiter = this.waiting.get(message.id);
      if (!waiter) return;
      this.waiting.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "CDP command failed"));
      else waiter.resolve(message.result);
    };
    socket.onclose = () => {
      for (const waiter of this.waiting.values()) waiter.reject(new Error("CDP target closed"));
      this.waiting.clear();
    };
  }

  static async open(target: CdpTarget): Promise<CdpConnection> {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`Cannot open CDP target ${target.url}`));
    });
    return new CdpConnection(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string, awaitPromise = false): Promise<unknown> {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed");
    }
    return result.result?.value;
  }

  close(): void {
    this.socket.close();
  }
}

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function waitFor<T>(label: string, read: () => Promise<T | undefined> | T | undefined, timeoutMs = 6000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function stopChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

describe.skipIf(!live)("Chrome bridge live Chromium fixture", () => {
  it("uses the real MV3 extension to snapshot, click, type and read text", async () => {
    const root = mkdtempSync(join(tmpdir(), "juno-chrome-live-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const profile = join(root, "profile");
    const userData = join(root, "juno-user-data");
    const chromeHome = join(root, "chrome-home");
    mkdirSync(profile, { recursive: true });
    mkdirSync(userData, { recursive: true });
    mkdirSync(chromeHome, { recursive: true });

    const fixtureHtml = `<!doctype html><html><body>
      <h1>Fixture heading</h1>
      <label for="name">Name</label><input id="name" autocomplete="off">
      <label for="card">Card number</label><input id="card" autocomplete="cc-number" value="4242 4242 4242 4242">
      <label for="otp">One-time code</label><input id="otp" autocomplete="one-time-code" value="123456">
      <button id="action" onclick="document.getElementById('result').textContent='Clicked fixture'; window.__junoClicked=true">Click fixture</button>
      <p id="result">Waiting</p><p>Bridge prose</p>
    </body></html>`;
    const server: Server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fixtureHtml);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server did not expose a port");
    const fixtureUrl = `http://127.0.0.1:${address.port}/`;

    const desktop = join(import.meta.dirname, "../../vendor");
    const extensionPath = join(desktop, "chrome-extension");
    // Desktop is protected by macOS privacy; Chrome-hosted QA binaries run from the temporary root.
    const nativeHostPath = join(root, "juno-chrome-host");
    cpSync(join(desktop, "chrome-bridge", "juno-chrome-host"), nativeHostPath);
    chmodSync(nativeHostPath, 0o700);
    const bridge: ChromeBridge = createChromeBridge({ userDataDir: userData, extensionPath, nativeHostPath, chromeHome });
    cleanup.push(() => bridge.stop());
    await bridge.setup();

    // Chrome for Testing 153 accepts an isolated per-profile native host manifest.
    // This file lives only in the temporary browser profile, never the owner's Chrome state.
    const hostManifestDir = join(profile, "NativeMessagingHosts");
    mkdirSync(hostManifestDir, { recursive: true });
    writeFileSync(join(hostManifestDir, "io.github.nigelleong0703.juno.chrome.json"), JSON.stringify({
      name: "io.github.nigelleong0703.juno.chrome",
      description: "Juno live fixture",
      path: join(userData, "chrome-bridge", "native-host"),
      type: "stdio",
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
    }));
    chmodSync(join(userData, "chrome-bridge", "native-host"), 0o700);

    const stderr: string[] = [];
    const chrome = spawn(chromeExecutable, [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      fixtureUrl,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    cleanup.push(() => stopChrome(chrome));
    chrome.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

    const activePort = await waitFor("Chrome DevToolsActivePort", () => {
      const path = join(profile, "DevToolsActivePort");
      return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n")[0] : undefined;
    }, 10_000);
    const listTargets = async (): Promise<CdpTarget[]> => {
      const response = await fetch(`http://127.0.0.1:${activePort}/json/list`);
      return await response.json() as CdpTarget[];
    };
    const fixtureTarget = await waitFor("fixture page target", async () => (await listTargets()).find((target) => target.type === "page" && target.url === fixtureUrl), 10_000);

    await fetch(`http://127.0.0.1:${activePort}/json/new?chrome-extension://${CHROME_EXTENSION_ID}/popup.html`, { method: "PUT" });
    const popupTarget = await waitFor("extension popup target", async () => (await listTargets()).find((target) => target.url.includes(`${CHROME_EXTENSION_ID}/popup.html`)));
    const popup = await CdpConnection.open(popupTarget);
    cleanup.push(() => popup.close());
    await waitFor("extension page API", async () => {
      const ready = await popup.evaluate("location.protocol === 'chrome-extension:' && typeof chrome.tabs?.query === 'function' && typeof chrome.runtime?.sendMessage === 'function'");
      return ready === true ? true : undefined;
    });
    const fixtureTab = await waitFor("fixture tab id", () => popup.evaluate(`(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(tab=>tab.url===${JSON.stringify(fixtureUrl)})?.id;})()`, true));
    const grant = await popup.evaluate(`(async()=>{await chrome.tabs.update(${String(fixtureTab)},{active:true});return await chrome.runtime.sendMessage({type:'bridge:allow-current'});})()`, true) as { ok?: boolean; error?: string };
    expect(grant).toMatchObject({ ok: true });
    try {
      await waitFor("native bridge connection", () => bridge.connected() || undefined, 8000);
    } catch (error) {
      const status = await popup.evaluate("chrome.runtime.sendMessage({type:'bridge:status'})", true).catch((reason: unknown) => String(reason));
      throw new Error(
        `${String(error)}; status=${JSON.stringify(status)}; chrome=${stderr.join("").slice(-3000)}`,
        { cause: error },
      );
    }

    const snapshot = await bridge.browser("agent-live", { action: "snapshot" }, new AbortController().signal) as {
      nodes: Array<{ ref?: string; role?: string; name?: string; value?: string }>;
      tab: string;
    };
    expect(snapshot.tab).toMatch(/^mt[0-9a-z]+$/);
    const button = snapshot.nodes.find((node) => node.role === "button" && node.name === "Click fixture");
    const textbox = snapshot.nodes.find((node) => node.role === "textbox" && node.name === "Name");
    const card = snapshot.nodes.find((node) => node.role === "textbox" && node.name === "Card number");
    const otp = snapshot.nodes.find((node) => node.role === "textbox" && node.name === "One-time code");
    expect(button?.ref).toBeTruthy();
    expect(textbox?.ref).toBeTruthy();
    expect(card?.ref).toBeTruthy();
    expect(otp?.ref).toBeTruthy();
    expect(snapshot.nodes.every((node) => node.value === undefined)).toBe(true);

    await expect(bridge.browser("agent-live", { action: "type", ref: card!.ref, text: "4111 1111 1111 1111" }, new AbortController().signal)).rejects.toMatchObject({
      code: "SECRET_FIELD_REFUSED",
    });

    const clicked = await bridge.browser("agent-live", { action: "click", ref: button!.ref }, new AbortController().signal) as { clicked?: boolean };
    expect(clicked.clicked).toBe(true);
    const page = await CdpConnection.open(fixtureTarget);
    cleanup.push(() => page.close());
    await waitFor("clicked fixture state", async () => {
      const value = await page.evaluate("window.__junoClicked === true");
      return value === true ? value : undefined;
    });

    const typed = await bridge.browser("agent-live", { action: "type", ref: textbox!.ref, text: "Juno" }, new AbortController().signal) as { typed?: boolean };
    expect(typed.typed).toBe(true);
    expect(await page.evaluate("document.querySelector('#name').value")).toBe("Juno");

    const text = await bridge.browser("agent-live", { action: "get_text" }, new AbortController().signal) as { text?: string };
    expect(text.text).toContain("Fixture heading");
    expect(text.text).toContain("Clicked fixture");
    expect(text.text).toContain("Bridge prose");

    if (!bridge.connected()) throw new Error(`Chrome bridge disconnected during fixture: ${stderr.join("").slice(-2000)}`);
  }, 30_000);
});
