/**
 * VNC's classic DES challenge/response (RFC 6143 §7.2.2). VNC passwords are 8 bytes and the
 * response is the DES encryption of the 16-byte challenge using the password as the key (bit
 * reversed, per the protocol). Node's OpenSSL 3 dropped single-DES, so we use 3DES-EDE with the
 * same 8-byte key repeated three times, which is exactly single DES.
 *
 * This exists only so the server-side proxy can answer the challenge; the plaintext password never
 * reaches a client.
 */
import { createCipheriv } from 'node:crypto';

/** VNC keys use the low bit of each byte as a parity bit and are bit-reversed. */
const REVERSE = buildReverseTable();

export function vncPasswordKey(password: string): Buffer {
  const key = Buffer.alloc(8);
  for (let index = 0; index < 8; index += 1) {
    const byte = password.charCodeAt(index) & 0xff;
    key[index] = REVERSE[byte % 256] ?? 0;
  }
  return key;
}

export function encryptDesBlock(key: Buffer, block: Buffer): Buffer {
  // \`des-ede\` (not \`des-ede-ecb\`: Electron's BoringSSL only knows this name) takes K1||K2 (16 bytes). With K1 = K2 the EDE chain collapses to single DES.
  const doubled = Buffer.concat([key, key]);
  const cipher = createCipheriv('des-ede', doubled, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** The 16-byte response to a VNC auth challenge. */
export function vncResponse(password: string, challenge: Buffer): Buffer {
  const key = vncPasswordKey(password);
  return Buffer.concat([encryptDesBlock(key, challenge.subarray(0, 8)), encryptDesBlock(key, challenge.subarray(8, 16))]);
}

function buildReverseTable(): number[] {
  const table: number[] = new Array(256).fill(0);
  for (let value = 0; value < 256; value += 1) {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      if (value & (1 << bit)) reversed |= 1 << (7 - bit);
    }
    table[value] = reversed;
  }
  return table;
}
