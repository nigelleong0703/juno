import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  CHROME_EXTENSION_ID,
  NativeMessageDecoder,
  encodeNativeMessage,
  isRecord,
  nativeMessagingHostManifestPath,
  nativeMessagingManifest,
  sameSecret,
  type ChromeBridgeRuntime,
} from "./chrome-bridge-protocol";

export type ChromeBridgeOutcome = "not_dispatched" | "unknown";

export class ChromeBridgeError extends Error {
  readonly code: string;
  readonly outcome: ChromeBridgeOutcome | "reported";

  constructor(code: string, message: string, outcome: ChromeBridgeOutcome | "reported") {
    super(message);
    this.name = "ChromeBridgeError";
    this.code = code;
    this.outcome = outcome;
  }
}

export interface CreateChromeBridgeOptions {
  userDataDir: string;
  extensionPath: string;
  nativeHostPath: string;
  executablePath?: string;
  /** Isolated tests and QA override the native-host manifest root; production uses the real home. */
  chromeHome?: string;
}

export interface ChromeBridge {
  browser(agentId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  setup(): Promise<void>;
  stop(): void;
  extensionPath: string;
  connected(): boolean;
}

interface PendingRequest {
  peer: Peer;
  resolve(value: unknown): void;
  reject(error: Error): void;
  removeAbortListener(): void;
}

interface Peer {
  socket: Socket;
  decoder: NativeMessageDecoder;
  authenticated: boolean;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function absolutePath(label: string, value: string): string {
  if (!value || value.includes("\0") || value.includes("\n")) throw new Error(`${label} must be a plain absolute path`);
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return resolve(value);
}

function writePrivateFile(path: string, data: string): void {
  writeFileSync(path, data, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
}

/** The launcher lets Chrome start a packaged host with this bridge's private runtime path. */
function launcherSource(options: CreateChromeBridgeOptions, runtimePath: string): string {
  if (options.executablePath) {
    return `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${quoteShell(options.executablePath)} ${quoteShell(options.nativeHostPath)} --runtime-file ${quoteShell(runtimePath)}\n`;
  }
  return `#!/bin/sh\nexec ${quoteShell(options.nativeHostPath)} --runtime-file ${quoteShell(runtimePath)}\n`;
}

/**
 * Existing-Chrome bridge. The desktop owns an owner-only Unix socket; Chrome launches a native
 * messaging relay which authenticates to it with the token in a 0600 runtime file. No network
 * port is opened and the token is never sent to a page or the extension.
 */
export function createChromeBridge(options: CreateChromeBridgeOptions): ChromeBridge {
  const userDataDir = absolutePath("userDataDir", options.userDataDir);
  const extensionPath = absolutePath("extensionPath", options.extensionPath);
  const nativeHostPath = absolutePath("nativeHostPath", options.nativeHostPath);
  const executablePath = options.executablePath ? absolutePath("executablePath", options.executablePath) : undefined;
  const chromeHome = absolutePath("chromeHome", options.chromeHome ?? homedir());
  const bridgeDir = join(userDataDir, "chrome-bridge");
  // Unix-domain paths are limited to roughly 104 bytes on macOS, so keep the socket name in userData short.
  const socketPath = join(userDataDir, ".jcb.sock");
  const runtimePath = join(bridgeDir, "runtime.json");
  const launcherPath = join(bridgeDir, "native-host");
  const pending = new Map<string, PendingRequest>();
  let server: Server | undefined;
  let activePeer: Peer | undefined;
  let token = "";
  let stopped = false;
  let setupTask: Promise<void> | undefined;

  const connected = (): boolean => activePeer !== undefined && activePeer.authenticated && !activePeer.socket.destroyed;

  const failPeer = (peer: Peer, message: string): void => {
    if (activePeer === peer) activePeer = undefined;
    for (const [id, request] of pending) {
      if (request.peer !== peer) continue;
      pending.delete(id);
      request.removeAbortListener();
      request.reject(new ChromeBridgeError("BROWSER_OUTCOME_UNKNOWN", message, "unknown"));
    }
  };

  const sendPeer = (peer: Peer, value: unknown): void => {
    if (peer.socket.destroyed) return;
    peer.socket.write(encodeNativeMessage(value));
  };

  const handleMessage = (peer: Peer, value: unknown): void => {
    if (!isRecord(value) || typeof value.type !== "string") {
      peer.socket.destroy();
      return;
    }
    if (!peer.authenticated) {
      if (value.type !== "auth" || typeof value.token !== "string" || !sameSecret(value.token, token)) {
        sendPeer(peer, { type: "error", code: "BRIDGE_AUTH_REJECTED", message: "Bridge authentication failed" });
        peer.socket.destroy();
        return;
      }
      if (activePeer && activePeer !== peer) {
        const previous = activePeer;
        activePeer = undefined;
        previous.socket.destroy(new Error("A newer Chrome bridge connection replaced this one"));
      }
      peer.authenticated = true;
      activePeer = peer;
      sendPeer(peer, { type: "ready", version: 1 });
      return;
    }

    if (value.type === "response" && typeof value.id === "string") {
      const request = pending.get(value.id);
      if (!request || request.peer !== peer) return;
      pending.delete(value.id);
      request.removeAbortListener();
      if (value.ok === true) {
        request.resolve(value.result);
        return;
      }
      const error = isRecord(value.error) ? value.error : {};
      const code = typeof error.code === "string" ? error.code : "BROWSER_COMMAND_FAILED";
      const message = typeof error.message === "string" ? error.message : "Chrome browser command failed";
      const outcome = error.outcome === "not_dispatched" || error.outcome === "unknown" ? error.outcome : "reported";
      request.reject(new ChromeBridgeError(code, message, outcome));
      return;
    }

    if (value.type === "fatal") {
      const message = typeof value.message === "string" ? value.message : "Chrome bridge relay stopped";
      peer.socket.destroy(new Error(message));
    }
  };

  const accept = (socket: Socket): void => {
    const peer: Peer = { socket, decoder: new NativeMessageDecoder(), authenticated: false };
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      try {
        for (const message of peer.decoder.push(chunk)) handleMessage(peer, message);
      } catch {
        socket.destroy();
      }
    });
    socket.on("close", () => failPeer(peer, "Chrome bridge disconnected after the request was sent; the outcome is unknown. Check the current page before retrying."));
    socket.on("error", () => undefined);
  };

  const setupOnce = async (): Promise<void> => {
    if (stopped) throw new Error("Chrome bridge has stopped");
    if (!existsSync(extensionPath) || !statSync(extensionPath).isDirectory()) {
      throw new Error(`Chrome extension directory is missing: ${extensionPath}`);
    }
    if (!existsSync(nativeHostPath)) {
      throw new Error(`Chrome native host is missing: ${nativeHostPath}. Run scripts/build-chrome-bridge.mjs.`);
    }
    if (executablePath && !existsSync(executablePath)) {
      throw new Error(`Chrome native host executable is missing: ${executablePath}`);
    }

    mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
    chmodSync(bridgeDir, 0o700);
    const chromeManifestPath = nativeMessagingHostManifestPath(chromeHome);
    mkdirSync(join(chromeManifestPath, ".."), { recursive: true, mode: 0o755 });

    if (!server) {
      if (existsSync(socketPath)) {
        if (!lstatSync(socketPath).isSocket()) throw new Error(`Refusing to replace a non-socket bridge path: ${socketPath}`);
        unlinkSync(socketPath);
      }
      token = randomBytes(32).toString("base64url");
      const runtime: ChromeBridgeRuntime = { version: 1, socketPath, token };
      writePrivateFile(runtimePath, `${JSON.stringify(runtime)}\n`);
      writePrivateFile(launcherPath, launcherSource({ userDataDir, extensionPath, nativeHostPath, ...(executablePath ? { executablePath } : {}) }, runtimePath));
      chmodSync(launcherPath, 0o700);

      const nextServer = createServer(accept);
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          const onError = (error: Error) => rejectListen(error);
          nextServer.once("error", onError);
          nextServer.listen(socketPath, () => {
            nextServer.off("error", onError);
            resolveListen();
          });
        });
        chmodSync(socketPath, 0o600);
        server = nextServer;
      } catch (error) {
        nextServer.close();
        throw error;
      }
    }

    writeFileSync(chromeManifestPath, `${JSON.stringify(nativeMessagingManifest(launcherPath), null, 2)}\n`, { mode: 0o644 });
  };

  const setup = (): Promise<void> => {
    if (!setupTask) {
      setupTask = setupOnce().finally(() => {
        setupTask = undefined;
      });
    }
    return setupTask;
  };

  return {
    setup,
    extensionPath,
    connected,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const request of pending.values()) {
        request.removeAbortListener();
        request.reject(new ChromeBridgeError("BROWSER_OUTCOME_UNKNOWN", "Chrome bridge stopped after the request was sent; the outcome is unknown.", "unknown"));
      }
      pending.clear();
      activePeer?.socket.destroy();
      activePeer = undefined;
      server?.close();
      server = undefined;
      removeIfPresent(socketPath);
      removeIfPresent(runtimePath);
    },
    browser(agentId, input, signal): Promise<unknown> {
      if (stopped) return Promise.reject(new ChromeBridgeError("BRIDGE_STOPPED", "Chrome bridge is stopped; no request was sent.", "not_dispatched"));
      if (!agentId) return Promise.reject(new ChromeBridgeError("AGENT_REQUIRED", "Chrome browser commands require an agent id; no request was sent.", "not_dispatched"));
      if (signal.aborted) return Promise.reject(new ChromeBridgeError("BROWSER_ABORTED", "Chrome browser command was cancelled before dispatch.", "not_dispatched"));
      const peer = activePeer;
      if (!peer || !connected()) {
        return Promise.reject(new ChromeBridgeError("BRIDGE_NOT_CONNECTED", "Chrome bridge is offline; the request was not sent.", "not_dispatched"));
      }

      const id = randomUUID();
      let frame: Buffer;
      try {
        frame = encodeNativeMessage({ type: "request", id, agentId, input });
      } catch (error) {
        return Promise.reject(new ChromeBridgeError("INVALID_REQUEST", error instanceof Error ? error.message : "Invalid browser request", "not_dispatched"));
      }

      return new Promise<unknown>((resolveRequest, rejectRequest) => {
        const onAbort = () => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.removeAbortListener();
          if (activePeer === peer && !peer.socket.destroyed) sendPeer(peer, { type: "cancel", id });
          rejectRequest(new ChromeBridgeError("BROWSER_ABORTED", "Chrome browser command was cancelled after dispatch; its outcome is unknown.", "unknown"));
        };
        const removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        pending.set(id, { peer, resolve: resolveRequest, reject: rejectRequest, removeAbortListener });
        signal.addEventListener("abort", onAbort, { once: true });
        peer.socket.write(frame, (error?: Error | null) => {
          if (!error) return;
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.removeAbortListener();
          rejectRequest(new ChromeBridgeError("BROWSER_OUTCOME_UNKNOWN", "Chrome bridge write failed after dispatch; the outcome is unknown.", "unknown"));
        });
      });
    },
  };
}

/** Exported for the setup notice so the app and documentation agree on the installed id. */
export const chromeBridgeExtensionId = CHROME_EXTENSION_ID;
