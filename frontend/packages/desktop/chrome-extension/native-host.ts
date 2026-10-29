import { readFileSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { NativeMessageDecoder, encodeNativeMessage, isRecord, type ChromeBridgeRuntime } from "../src/main/chrome-bridge-protocol";

const MAX_RUNTIME_BYTES = 8_192;

function runtimeArgument(): string {
  const index = process.argv.indexOf("--runtime-file");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || !isAbsolute(value)) throw new Error("native host needs an absolute --runtime-file path");
  return value;
}

function readRuntime(path: string): ChromeBridgeRuntime {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_RUNTIME_BYTES) throw new Error("bridge runtime is not a small regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("bridge runtime must be owner-only (0600)");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("bridge runtime is owned by another user");
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.socketPath !== "string" || typeof parsed.token !== "string") {
    throw new Error("bridge runtime is invalid");
  }
  if (!isAbsolute(parsed.socketPath) || parsed.token.length < 32 || parsed.token.length > 512) throw new Error("bridge runtime credentials are invalid");
  return { version: 1, socketPath: parsed.socketPath, token: parsed.token };
}

let finished = false;

function writeNative(value: unknown): void {
  if (finished) return;
  try {
    process.stdout.write(encodeNativeMessage(value));
  } catch {
    finish(1);
  }
}

function finish(code: number): void {
  if (finished) return;
  finished = true;
  process.exitCode = code;
  process.stdin.pause();
  setTimeout(() => process.exit(code), 20);
}

function fatal(message: string): void {
  writeNative({ type: "bridge-error", code: "NATIVE_HOST_UNAVAILABLE", message });
  finish(1);
}

let socket: Socket | undefined;
try {
  const runtime = readRuntime(runtimeArgument());
  const socketDecoder = new NativeMessageDecoder();
  const nativeDecoder = new NativeMessageDecoder();
  const queued: unknown[] = [];
  let authenticated = false;

  const relay = createConnection(runtime.socketPath);
  socket = relay;
  relay.setNoDelay(true);
  relay.on("connect", () => {
    relay.write(encodeNativeMessage({ type: "auth", token: runtime.token }));
  });
  relay.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = socketDecoder.push(chunk);
    } catch {
      fatal("Juno bridge sent an invalid frame");
      return;
    }
    for (const message of messages) {
      if (!isRecord(message) || typeof message.type !== "string") {
        fatal("Juno bridge sent an invalid message");
        return;
      }
      if (!authenticated) {
        if (message.type === "ready") {
          authenticated = true;
          writeNative({ type: "ready", version: 1 });
          for (const pending of queued.splice(0)) relay.write(encodeNativeMessage(pending));
          continue;
        }
        if (message.type === "error") {
          writeNative({ type: "bridge-error", code: message.code, message: message.message });
          finish(1);
          return;
        }
        fatal("Juno bridge did not authenticate the relay");
        return;
      }
      writeNative(message);
    }
  });
  relay.on("error", (error) => fatal(`Cannot reach Juno desktop: ${error.message}`));
  relay.on("close", () => finish(0));

  process.stdin.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = nativeDecoder.push(chunk);
    } catch {
      fatal("Chrome sent an invalid native message");
      return;
    }
    for (const message of messages) {
      if (!authenticated) {
        if (queued.length >= 32) {
          fatal("Chrome queued too many messages before Juno connected");
          return;
        }
        queued.push(message);
      } else {
        relay.write(encodeNativeMessage(message));
      }
    }
  });
  process.stdin.on("end", () => relay.end());
  process.stdin.on("error", () => finish(1));
} catch (error) {
  fatal(error instanceof Error ? error.message : "Chrome native host could not start");
}

process.on("SIGTERM", () => {
  socket?.destroy();
  finish(0);
});
