import { x25519 } from "@noble/curves/ed25519.js";

export const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** What the sandbox does: open a sealed value with its private key. */
export async function openSealed(sealed: { epk: string; nonce: string; ciphertext: string }, privateKey: string, requestId: string, fieldId: string, ref: string) {
  const shared = x25519.getSharedSecret(bytes(privateKey), bytes(sealed.epk));
  const base = await crypto.subtle.importKey("raw", shared as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode(requestId), info: new TextEncoder().encode("juno-secure-input-v1") },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(sealed.nonce), additionalData: new TextEncoder().encode(`${requestId}|${fieldId}|${ref}`) },
    key, bytes(sealed.ciphertext),
  );
  return new TextDecoder().decode(plain);
}
