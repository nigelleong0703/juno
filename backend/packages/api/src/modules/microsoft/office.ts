/**
 * Plain text out of Office files (docx, xlsx, pptx are zip archives of XML) without a dependency: a minimal zip reader
 * over node:zlib, then the text runs of the parts that carry the content. PDFs are not read (no extractor here).
 */
import { inflateRawSync } from 'node:zlib';

/** The entries of a zip archive whose names pass `wanted`, decompressed. Stored and deflated entries only. */
export function unzip(buffer: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const found = new Map<string, Buffer>();
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65_557); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip archive');
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count && buffer.readUInt32LE(at) === 0x02014b50; index += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(dataAt, dataAt + compressed);
    if (method === 0) found.set(name, data);
    else if (method === 8) found.set(name, inflateRawSync(data));
  }
  return found;
}

const entities = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const runs = (xml: string, tag: string) => [...xml.matchAll(new RegExp('<' + tag + '(?: [^>]*)?>([^<]*)</' + tag + '>', 'g'))].map((match) => entities(match[1] ?? '')).join('');

function docx(files: Map<string, Buffer>): string {
  const xml = files.get('word/document.xml')?.toString('utf8') ?? '';
  return xml.split(/<\/w:p>/).map((paragraph) => runs(paragraph.replace(/<w:tab\/>/g, '<w:t>\t</w:t>'), 'w:t')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function pptx(files: Map<string, Buffer>): string {
  const slides = [...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]));
  return slides.map((name, index) => 'Slide ' + String(index + 1) + '\n' + (files.get(name)?.toString('utf8') ?? '').split(/<\/a:p>/).map((paragraph) => runs(paragraph, 'a:t')).filter((text) => text !== '').join('\n')).join('\n\n');
}

/** First sheet as tab-separated rows (shared strings resolved). */
function xlsx(files: Map<string, Buffer>): string {
  const shared = [...(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => runs(match[1] ?? '', 't'));
  const sheet = files.get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
  const lines: string[] = [];
  for (const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of (row[1] ?? '').matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? '';
      const column = (/r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? '').split('').reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      const inner = cell[2] ?? '';
      const raw = /<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? '';
      const value = /t="s"/.test(attrs) ? shared[Number(raw)] ?? '' : /t="inlineStr"/.test(attrs) ? runs(inner, 't') : entities(raw);
      if (column >= 0) cells[column] = value;
    }
    lines.push(Array.from(cells, (cell) => cell ?? '').join('\t'));
  }
  return lines.join('\n').trim();
}

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export function officeKind(name: string): OfficeKind | undefined {
  const extension = /\.(docx|xlsx|pptx)$/i.exec(name)?.[1]?.toLowerCase();
  return extension === 'docx' || extension === 'xlsx' || extension === 'pptx' ? extension : undefined;
}

export function officeText(buffer: Buffer, kind: OfficeKind): string {
  const files = unzip(buffer, (name) => /^(word\/document|xl\/sharedStrings|xl\/worksheets\/sheet1|ppt\/slides\/slide\d+)\.xml$/.test(name));
  return kind === 'docx' ? docx(files) : kind === 'xlsx' ? xlsx(files) : pptx(files);
}
