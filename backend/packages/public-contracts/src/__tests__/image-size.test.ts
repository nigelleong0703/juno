import { describe, expect, it } from 'vitest';
import { imageSize } from '../image-size.js';

const bytes = (...n: number[]): Uint8Array => Uint8Array.from(n);

describe('imageSize', () => {
  it('reads PNG', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 3, 0x20, 0, 0, 2, 0x58);
    expect(imageSize(png)).toEqual({ width: 800, height: 600 });
  });

  it('reads JPEG past other segments', () => {
    const jpg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 1, 0xe0, 2, 0x80, 3, 1, 0x11, 0);
    expect(imageSize(jpg)).toEqual({ width: 640, height: 480 });
  });

  it('reads WebP VP8X and VP8L', () => {
    const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    const vp8x = bytes(...riff, 0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0, 0x1f, 0x03, 0, 0xc7, 0x01, 0);
    expect(imageSize(Uint8Array.from([...vp8x, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ width: 800, height: 456 });
    // VP8L: width 100 -> 99, height 50 -> 49 packed as 14-bit fields.
    const bits = 99 | (49 << 14);
    const vp8l = bytes(...riff, 0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f, bits & 255, (bits >> 8) & 255, (bits >> 16) & 255, (bits >>> 24) & 255);
    expect(imageSize(Uint8Array.from([...vp8l, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toEqual({ width: 100, height: 50 });
  });

  it('returns undefined for non-images and truncated input', () => {
    expect(imageSize(bytes(1, 2, 3))).toBeUndefined();
    expect(imageSize(bytes(0x89, 0x50, 0x4e, 0x47))).toBeUndefined();
    expect(imageSize(new TextEncoder().encode('hello world, plain text'))).toBeUndefined();
  });
});
