import type { SecureInputEncryption, SecureInputField, SealedSecureValue } from "@agent-desktop/client";
import { x25519 } from "@noble/curves/ed25519.js";

/** Seals secure-input values to the sandbox key (BACKEND 8.7 item 7). X25519 comes from noble: WebCrypto lacks it in some browsers. */

const INFO = new TextEncoder().encode("juno-secure-input-v1");

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Fixed keys and nonce, only for the shared test vector. */
export interface SealOverrides {
  ephemeralPrivateKey?: Uint8Array;
  nonce?: Uint8Array<ArrayBuffer>;
}

export async function sealSecureValue(
  encryption: SecureInputEncryption,
  requestId: string,
  field: Pick<SecureInputField, "id" | "ref">,
  value: string,
  overrides: SealOverrides = {},
): Promise<SealedSecureValue> {
  const priv = overrides.ephemeralPrivateKey ?? x25519.utils.randomSecretKey();
  const shared = x25519.getSharedSecret(priv, fromBase64(encryption.publicKey));
  const base = await crypto.subtle.importKey("raw", shared as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(requestId), info: INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const nonce = overrides.nonce ?? crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`${requestId}|${field.id}|${field.ref ?? ""}`);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData }, key, new TextEncoder().encode(value));
  return { epk: toBase64(x25519.getPublicKey(priv)), nonce: toBase64(nonce), ciphertext: toBase64(new Uint8Array(sealed)) };
}

/** One sealed value per non-empty field; an empty optional field is omitted. */
export async function sealSecureValues(
  encryption: SecureInputEncryption,
  requestId: string,
  fields: readonly SecureInputField[],
  values: Record<string, string>,
): Promise<Record<string, SealedSecureValue>> {
  const out: Record<string, SealedSecureValue> = {};
  for (const field of fields) {
    const value = values[field.id] ?? "";
    if (value.trim().length > 0) out[field.id] = await sealSecureValue(encryption, requestId, field, value);
  }
  return out;
}
