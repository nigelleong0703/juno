/**
 * The VNC DES challenge/response. A wrong response would make every real stream fail its handshake,
 * so this pins the implementation against the VNC bit-reversal and DES-ECB rules.
 */
import { describe, expect, it } from 'vitest';
import { vncPasswordKey, vncResponse } from './des.js';

describe('vnc DES', () => {
  it('bit-reverses each password byte into the DES key', () => {
    // 0x61 = 0b01100001 -> 0b10000110 = 0x86.
    expect(vncPasswordKey('a\u0000\u0000\u0000\u0000\u0000\u0000\u0000')[0]).toBe(0x86);
  });

  it('encrypts the two challenge halves with the same key', () => {
    const challenge = Buffer.from('00000000000000000000000000000000', 'hex');
    const response = vncResponse('abcd1234', challenge);
    expect(response).toHaveLength(16);
    expect(response.subarray(0, 8).equals(response.subarray(8, 16))).toBe(true);
  });
});

