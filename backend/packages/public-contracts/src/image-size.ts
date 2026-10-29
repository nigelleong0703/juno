/**
 * Pixel size of a PNG, JPEG, WebP or GIF, read from the file header only (no decoding).
 * Returns undefined for anything else or a truncated/corrupt header.
 */
export interface ImageSize {
  width: number;
  height: number;
}

export function imageSize(bytes: Uint8Array): ImageSize | undefined {
  const size = readSize(bytes);
  return size !== undefined && size.width > 0 && size.height > 0 ? size : undefined;
}

function u16be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}
function u32be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) * 0x1000000) + (((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0));
}
function u16le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}
function u24le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16);
}
function ascii(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i += 1) s += String.fromCharCode(b[o + i] ?? 0);
  return s;
}

function readSize(b: Uint8Array): ImageSize | undefined {
  // PNG: signature, then IHDR with big-endian width/height at 16..24.
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  // GIF: little-endian width/height at 6..10.
  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') {
    return { width: u16le(b, 6), height: u16le(b, 8) };
  }
  // WebP: RIFF container with a VP8 / VP8L / VP8X chunk first.
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X') return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) * 0x1000000);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    }
    return undefined;
  }
  // JPEG: walk segments to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) { o += 1; continue; }
      const marker = b[o + 1] ?? 0;
      if (marker === 0xff) { o += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { o += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return undefined;
      const len = u16be(b, o + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        if (o + 9 > b.length) return undefined;
        return { height: u16be(b, o + 5), width: u16be(b, o + 7) };
      }
      if (len < 2) return undefined;
      o += 2 + len;
    }
  }
  return undefined;
}
