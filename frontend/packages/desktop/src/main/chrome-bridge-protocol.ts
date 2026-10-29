import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

/** The public manifest key pins this id; private signing material never enters the repository. */
export const CHROME_EXTENSION_ID = "kbfjckdecckcdjaokfiphfipdpenodoj";
export const CHROME_NATIVE_HOST = "io.github.nigelleong0703.juno.chrome";
export const MAX_NATIVE_MESSAGE_BYTES = 1_048_576;

export interface ChromeBridgeRuntime {
  version: 1;
  socketPath: string;
  token: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Chrome native messaging uses a four-byte little-endian length and one UTF-8 JSON object. */
export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32LE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}

/** Incremental decoder so a large JSON frame may arrive over any number of reads. */
export class NativeMessageDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    if (chunk.byteLength > 0) this.pending = Buffer.concat([this.pending, chunk]);
    const messages: unknown[] = [];
    while (this.pending.byteLength >= 4) {
      const length = this.pending.readUInt32LE(0);
      if (length === 0 || length > MAX_NATIVE_MESSAGE_BYTES) {
        throw new Error(`invalid native message length: ${length}`);
      }
      if (this.pending.byteLength < 4 + length) break;
      const body = this.pending.subarray(4, 4 + length);
      this.pending = this.pending.subarray(4 + length);
      messages.push(JSON.parse(body.toString("utf8")) as unknown);
    }
    return messages;
  }
}

export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export function nativeMessagingHostManifestPath(
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", `${CHROME_NATIVE_HOST}.json`);
  }
  if (platform === "linux") {
    return join(home, ".config", "google-chrome", "NativeMessagingHosts", `${CHROME_NATIVE_HOST}.json`);
  }
  throw new Error(`Chrome native messaging host setup is unsupported on ${platform}`);
}

export function nativeMessagingManifest(launcherPath: string): Record<string, unknown> {
  return {
    name: CHROME_NATIVE_HOST,
    description: "Juno Chrome bridge",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
  };
}
