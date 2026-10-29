import { inflateRawSync } from 'node:zlib';

/** Entries of a zip (a .pptx is one), by name. Reads the central directory; stored and deflated entries only. */
export function readZip(data: Buffer): Map<string, Buffer> {
  let end = data.length - 22;
  while (end >= 0 && data.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error('not a zip file (no end-of-central-directory record)');
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = data.readUInt16LE(offset + 10);
    const size = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const raw = data.subarray(start, start + size);
    entries.set(name, method === 0 ? raw : inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Slides of a .pptx in order, each with its text runs (what python-pptx shows as `shape.text_frame` text). */
export function pptxSlides(data: Buffer): Array<{ name: string; texts: string[] }> {
  const zip = readZip(data);
  return [...zip.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]))
    .map((name) => ({
      name,
      texts: [...(zip.get(name)?.toString('utf8') ?? '').matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => (m[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()).filter(Boolean),
    }));
}
