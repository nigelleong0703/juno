/**
 * Raster image identification from the first bytes: the type by magic number (never the upstream header; SVG and
 * everything unlisted is refused) and the pixel size from the header. Shared by the API's media proxy and the feed's
 * image check, so both accept the same set.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImage(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const head = bytes.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  if (head.slice(4, 8) === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 32).toString('latin1'))) return 'image/avif';
  return null;
}

export interface ImageSize {
  width: number;
  height: number;
}

function jpegSize(b: Buffer): ImageSize | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) { i += 1; continue; }
    // Start-of-frame markers (not DHT 0xc4, JPG 0xc8, DAC 0xcc) carry the size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

function webpSize(b: Buffer): ImageSize | null {
  const kind = b.subarray(12, 16).toString('latin1');
  if (kind === 'VP8X' && b.length >= 30) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (kind === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (kind === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}

function avifSize(b: Buffer): ImageSize | null {
  const at = b.indexOf('ispe', 0, 'latin1');
  return at < 0 || at + 16 > b.length ? null : { width: b.readUInt32BE(at + 8), height: b.readUInt32BE(at + 12) };
}

/** Pixel size read from the header bytes; null when the type is unknown or the header is cut off. */
export function imageSize(bytes: Buffer): ImageSize | null {
  try {
    switch (sniffImage(bytes)) {
      case 'image/png': return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
      case 'image/gif': return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
      case 'image/jpeg': return jpegSize(bytes);
      case 'image/webp': return webpSize(bytes);
      case 'image/avif': return avifSize(bytes);
      default: return null;
    }
  } catch {
    return null;
  }
}
