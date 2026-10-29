import { describe, expect, it } from "vitest";
import { MAX_NATIVE_MESSAGE_BYTES, NativeMessageDecoder, encodeNativeMessage, sameSecret } from "./chrome-bridge-protocol";

describe("native messaging framing", () => {
  it("decodes split and back-to-back four-byte little-endian frames", () => {
    const first = encodeNativeMessage({ type: "ready", version: 1 });
    const second = encodeNativeMessage({ type: "response", id: "r1", ok: true, result: { text: "ok" } });
    const decoder = new NativeMessageDecoder();

    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second.subarray(0, 7)]))).toEqual([
      { type: "ready", version: 1 },
    ]);
    expect(decoder.push(second.subarray(7))).toEqual([
      { type: "response", id: "r1", ok: true, result: { text: "ok" } },
    ]);
  });

  it("rejects zero, oversized and malformed frame lengths", () => {
    const zero = Buffer.alloc(4);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
    expect(() => new NativeMessageDecoder().push(zero)).toThrow(/invalid native message length/);
    expect(() => new NativeMessageDecoder().push(oversized)).toThrow(/invalid native message length/);

    const malformed = Buffer.alloc(6);
    malformed.writeUInt32LE(2, 0);
    malformed.write("{}", 4);
    expect(() => new NativeMessageDecoder().push(malformed)).not.toThrow();
    const badJson = encodeNativeMessage({ ok: true }).subarray(0, 8);
    badJson.writeUInt32LE(4, 0);
    expect(() => new NativeMessageDecoder().push(badJson)).toThrow();
  });

  it("compares bridge tokens without accepting prefixes", () => {
    expect(sameSecret("token-token-token", "token-token-token")).toBe(true);
    expect(sameSecret("token-token-token", "token-token")).toBe(false);
    expect(sameSecret("token-token-token", "token-token-tokeX")).toBe(false);
  });
});
