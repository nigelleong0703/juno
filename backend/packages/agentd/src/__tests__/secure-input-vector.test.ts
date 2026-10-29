/**
 * The secure-input test vector (public-contracts/src/secure-input-vector.json) is what every client implements against
 * and what the sandbox helper's Python selftest opens. This reproduces it with node:crypto from its inputs, so the file
 * cannot drift from the algorithm in BACKEND 8.7, and shows the client side in a few lines (the web client does the same
 * with WebCrypto; the iOS client with CryptoKit).
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const vector = JSON.parse(readFileSync(new URL('../../../public-contracts/src/secure-input-vector.json', import.meta.url), 'utf8')) as {
  sandboxPrivateKey: string; sandboxPublicKey: string; keyId: string; ephemeralPrivateKey: string; ephemeralPublicKey: string; nonce: string;
  requestId: string; fieldId: string; ref: string; value: string; sealed: { epk: string; nonce: string; ciphertext: string };
};
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const privateKey = (raw: Buffer) => createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
const rawPublic = (key: ReturnType<typeof createPrivateKey>) => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);

function aesKey(shared: Buffer, requestId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.from(requestId, 'utf8'), Buffer.from('juno-secure-input-v1'), 32));
}

describe('secure-input test vector', () => {
  it('is what the documented algorithm produces', () => {
    const sandbox = privateKey(Buffer.from(vector.sandboxPrivateKey, 'base64'));
    expect(rawPublic(sandbox).toString('base64')).toBe(vector.sandboxPublicKey);
    expect(createHash('sha256').update(rawPublic(sandbox)).digest('hex').slice(0, 16)).toBe(vector.keyId);
    const eph = privateKey(Buffer.from(vector.ephemeralPrivateKey, 'base64'));
    expect(rawPublic(eph).toString('base64')).toBe(vector.sealed.epk);
    const key = aesKey(diffieHellman({ privateKey: eph, publicKey: createPublicKey(sandbox) }), vector.requestId);
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(vector.nonce, 'base64'));
    cipher.setAAD(Buffer.from(`${vector.requestId}|${vector.fieldId}|${vector.ref}`));
    const box = Buffer.concat([cipher.update(vector.value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    expect(box.toString('base64')).toBe(vector.sealed.ciphertext);
  });

  it('a fresh ephemeral key round-trips only for the same request, field and ref', () => {
    const sandbox = generateKeyPairSync('x25519');
    const eph = generateKeyPairSync('x25519');
    const nonce = randomBytes(12);
    const seal = (aad: string) => {
      const cipher = createCipheriv('aes-256-gcm', aesKey(diffieHellman({ privateKey: eph.privateKey, publicKey: sandbox.publicKey }), 'req-1'), nonce);
      cipher.setAAD(Buffer.from(aad));
      return Buffer.concat([cipher.update('s3cret', 'utf8'), cipher.final(), cipher.getAuthTag()]);
    };
    const open = (box: Buffer, aad: string) => {
      const decipher = createDecipheriv('aes-256-gcm', aesKey(diffieHellman({ privateKey: sandbox.privateKey, publicKey: eph.publicKey }), 'req-1'), nonce);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(box.subarray(-16));
      return Buffer.concat([decipher.update(box.subarray(0, -16)), decipher.final()]).toString('utf8');
    };
    const box = seal('req-1|f1|e12');
    expect(open(box, 'req-1|f1|e12')).toBe('s3cret');
    expect(() => open(box, 'req-1|f2|e12')).toThrow();
  });
});
