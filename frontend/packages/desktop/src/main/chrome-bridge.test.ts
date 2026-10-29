import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChromeBridge, type ChromeBridgeError } from "./chrome-bridge";
import { NativeMessageDecoder, encodeNativeMessage } from "./chrome-bridge-protocol";

interface Fixture {
  home: string;
  userData: string;
  extension: string;
  nativeHost: string;
}

const sockets: Socket[] = [];
let fixture: Fixture;

function makeFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "juno-bridge-home-"));
  const userData = join(home, "user-data");
  const extension = join(home, "extension");
  const nativeHost = join(home, "juno-chrome-host");
  mkdirSync(userData, { recursive: true });
  mkdirSync(extension, { recursive: true });
  writeFileSync(nativeHost, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(nativeHost, 0o700);
  return { home, userData, extension, nativeHost };
}

function reader(socket: Socket) {
  const decoder = new NativeMessageDecoder();
  const messages: unknown[] = [];
  const waiters: Array<{ resolve(value: unknown): void; reject(error: Error): void }> = [];
  socket.on("data", (chunk: Buffer) => {
    let decoded: unknown[];
    try {
      decoded = decoder.push(chunk);
    } catch (error) {
      for (const waiter of waiters.splice(0)) waiter.reject(error as Error);
      return;
    }
    for (const message of decoded) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    }
  });
  socket.on("close", () => {
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("socket closed"));
  });
  return {
    next(): Promise<unknown> {
      const message = messages.shift();
      if (message !== undefined) return Promise.resolve(message);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

async function openSocket(path: string): Promise<Socket> {
  const socket = connect(path);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

beforeEach(() => {
  fixture = makeFixture();
});

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  rmSync(fixture.home, { recursive: true, force: true });
});

describe("Chrome bridge transport", () => {
  it("installs an exact-origin manifest and accepts only the owner-token handshake", async () => {
    const bridge = createChromeBridge({
      userDataDir: fixture.userData,
      extensionPath: fixture.extension,
      nativeHostPath: fixture.nativeHost,
      chromeHome: fixture.home,
    });
    await bridge.setup();
    expect(bridge.connected()).toBe(false);

    const runtime = JSON.parse(readFileSync(join(fixture.userData, "chrome-bridge", "runtime.json"), "utf8"));
    expect(statSync(join(fixture.userData, "chrome-bridge", "runtime.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(fixture.userData, ".jcb.sock")).mode & 0o777).toBe(0o600);

    const manifestPath = join(fixture.home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "io.github.nigelleong0703.juno.chrome.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      name: "io.github.nigelleong0703.juno.chrome",
      type: "stdio",
      allowed_origins: ["chrome-extension://kbfjckdecckcdjaokfiphfipdpenodoj/"],
    });
    expect(JSON.stringify(manifest)).not.toContain(runtime.token);

    const rejected = await openSocket(runtime.socketPath);
    const rejectedReader = reader(rejected);
    rejected.write(encodeNativeMessage({ type: "auth", token: "wrong-token-but-long-enough-for-the-wire" }));
    await expect(rejectedReader.next()).resolves.toMatchObject({ type: "error", code: "BRIDGE_AUTH_REJECTED" });
    expect(bridge.connected()).toBe(false);

    const accepted = await openSocket(runtime.socketPath);
    const acceptedReader = reader(accepted);
    accepted.write(encodeNativeMessage({ type: "auth", token: runtime.token }));
    await expect(acceptedReader.next()).resolves.toMatchObject({ type: "ready", version: 1 });
    expect(bridge.connected()).toBe(true);
    bridge.stop();
    expect(bridge.connected()).toBe(false);
  });

  it("rejects an interrupted dispatched mutation as outcome unknown and never retries it", async () => {
    const bridge = createChromeBridge({
      userDataDir: fixture.userData,
      extensionPath: fixture.extension,
      nativeHostPath: fixture.nativeHost,
      chromeHome: fixture.home,
    });
    await bridge.setup();
    const runtime = JSON.parse(readFileSync(join(fixture.userData, "chrome-bridge", "runtime.json"), "utf8"));
    const socket = await openSocket(runtime.socketPath);
    const socketReader = reader(socket);
    socket.write(encodeNativeMessage({ type: "auth", token: runtime.token }));
    await socketReader.next();

    const pending = bridge.browser("agent-a", { action: "click", ref: "e1" }, new AbortController().signal);
    const dispatched = await socketReader.next();
    expect(dispatched).toMatchObject({ type: "request", agentId: "agent-a", input: { action: "click", ref: "e1" } });
    socket.destroy();

    await expect(pending).rejects.toMatchObject({
      name: "ChromeBridgeError",
      code: "BROWSER_OUTCOME_UNKNOWN",
      outcome: "unknown",
    } satisfies Partial<ChromeBridgeError>);
    await expect(pending).rejects.toThrow(/outcome is unknown/);
    expect(bridge.connected()).toBe(false);
    await expect(bridge.browser("agent-a", { action: "click", ref: "e1" }, new AbortController().signal)).rejects.toMatchObject({
      code: "BRIDGE_NOT_CONNECTED",
      outcome: "not_dispatched",
    });
    bridge.stop();
  });

  it("is repeatable across app startup and retryable once the packaged host appears", async () => {
    const missingHost = join(fixture.home, "missing-host");
    const bridge = createChromeBridge({
      userDataDir: fixture.userData,
      extensionPath: fixture.extension,
      nativeHostPath: missingHost,
      chromeHome: fixture.home,
    });
    await expect(bridge.setup()).rejects.toThrow(/native host is missing/);
    writeFileSync(missingHost, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await bridge.setup();
    expect(existsSync(join(fixture.userData, ".jcb.sock"))).toBe(true);
    const firstRuntime = readFileSync(join(fixture.userData, "chrome-bridge", "runtime.json"), "utf8");
    await bridge.setup();
    expect(readFileSync(join(fixture.userData, "chrome-bridge", "runtime.json"), "utf8")).toBe(firstRuntime);
    bridge.stop();
  });
});
