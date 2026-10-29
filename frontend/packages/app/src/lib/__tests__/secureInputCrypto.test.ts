import { describe, expect, it } from "vitest";
import { sealSecureValue } from "../secureInputCrypto";
import { bytes, openSealed } from "./openSealed";
import vector from "./secure-input-vector.json";

const encryption = { alg: "X25519-HKDF-SHA256-AES256GCM" as const, keyId: vector.keyId, publicKey: vector.sandboxPublicKey };

describe("secure input sealing", () => {
  it("matches the shared vector byte for byte", async () => {
    const sealed = await sealSecureValue(encryption, vector.requestId, { id: vector.fieldId, ref: vector.ref }, vector.value, {
      ephemeralPrivateKey: bytes(vector.ephemeralPrivateKey),
      nonce: bytes(vector.nonce),
    });
    expect(sealed).toEqual(vector.sealed);
  });

  it("opens with the sandbox key, and not under another field or request", async () => {
    const sealed = await sealSecureValue(encryption, "req_x", { id: "f2", ref: "e3" }, "hunter2 é");
    expect(await openSealed(sealed, vector.sandboxPrivateKey, "req_x", "f2", "e3")).toBe("hunter2 é");
    await expect(openSealed(sealed, vector.sandboxPrivateKey, "req_x", "f1", "e3")).rejects.toThrow();
    await expect(openSealed(sealed, vector.sandboxPrivateKey, "req_y", "f2", "e3")).rejects.toThrow();
  });
});
