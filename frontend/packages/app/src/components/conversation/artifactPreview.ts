import type { FileDownload, LibraryItem } from "@agent-desktop/client";
import { unzipSync } from "fflate";
import { archiveEntries, officePreview, validateOfficeArchive } from "./artifactOffice";

const TEXT_LIMIT = 256 * 1024;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const OOXML_LIMIT = 8 * 1024 * 1024;
const PDF_LIMIT = 10 * 1024 * 1024;
const MEDIA_LIMIT = 16 * 1024 * 1024;
const textMimes = new Set(["text/plain", "text/markdown", "text/x-markdown", "text/csv", "application/json", "application/xml", "text/xml", "text/x-python", "text/javascript", "application/javascript"]);
const imageMimes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const extensionMimes = new Map<string, Set<string>>([
  ["txt", new Set(["text/plain"])], ["md", new Set(["text/markdown", "text/x-markdown"])],
  ["csv", new Set(["text/csv", "text/plain"])], ["json", new Set(["application/json", "text/plain"])],
  ["xml", new Set(["application/xml", "text/xml", "text/plain"])],
  ["py", new Set(["text/x-python", "text/plain"])], ["js", new Set(["text/javascript", "application/javascript", "text/plain"])],
  ["ts", new Set(["text/plain", "text/javascript", "application/javascript"])],
  ["jsx", new Set(["text/plain", "text/javascript", "application/javascript"])], ["tsx", new Set(["text/plain", "text/javascript", "application/javascript", "application/typescript", "text/typescript"])],
  ["css", new Set(["text/plain", "text/css"])], ["sh", new Set(["text/plain", "application/x-sh", "text/x-shellscript", "text/x-sh"])],
  ["sql", new Set(["text/plain", "application/sql", "text/x-sql"])], ["go", new Set(["text/plain", "text/x-go"])],
  ["rs", new Set(["text/plain", "text/rust"])], ["java", new Set(["text/plain", "text/x-java-source"])],
  ["c", new Set(["text/plain", "text/x-c"] )], ["h", new Set(["text/plain", "text/x-c"] )],
  ["cpp", new Set(["text/plain", "text/x-c++src"])], ["hpp", new Set(["text/plain", "text/x-c++hdr"])],
  ["yml", new Set(["text/plain", "application/yaml", "text/yaml"])], ["yaml", new Set(["text/plain", "application/yaml", "text/yaml"])],
  ["toml", new Set(["text/plain", "application/toml"])], ["log", new Set(["text/plain"])],
  ["png", new Set(["image/png"])], ["jpg", new Set(["image/jpeg"])], ["jpeg", new Set(["image/jpeg"])],
  ["webp", new Set(["image/webp"])], ["gif", new Set(["image/gif"])], ["avif", new Set(["image/avif"])],
  ["xlsx", new Set(["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"])],
  ["docx", new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"])],
  ["pptx", new Set(["application/vnd.openxmlformats-officedocument.presentationml.presentation"])],
  ["zip", new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream"])],
  ["pdf", new Set(["application/pdf"])],
  ["mp3", new Set(["audio/mpeg"])], ["wav", new Set(["audio/wav", "audio/x-wav"])], ["ogg", new Set(["audio/ogg"])],
  ["m4a", new Set(["audio/mp4"])], ["mp4", new Set(["video/mp4"])], ["webm", new Set(["video/webm", "audio/webm"])],
  ["mov", new Set(["video/quicktime"])], ["ogv", new Set(["video/ogg"])],
]);

function mime(value: string): string { return value.split(";")[0]?.trim().toLowerCase() ?? ""; }
function extension(name: string): string { return name.split("/").pop()?.split(".").pop()?.toLowerCase() ?? ""; }
function compatible(name: string, type: string): boolean { return extensionMimes.get(extension(name))?.has(type) ?? false; }
function isOffice(ext: string): boolean { return ext === "xlsx" || ext === "docx" || ext === "pptx"; }
function isZip(bytes: Uint8Array): boolean {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return true;
  const start = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= start; index -= 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x05 && bytes[index + 3] === 0x06) return true;
  }
  return false;
}

export type PreviewKind = "text" | "image" | "table" | "document" | "slides" | "archive" | "pdf" | "media";
export function previewKind(item: LibraryItem): PreviewKind | null {
  const type = mime(item.mimeType);
  const ext = extension(item.name);
  if (!compatible(item.name, type)) return null;
  if (ext === "csv" && item.sizeBytes <= TEXT_LIMIT) return "table";
  if (textMimes.has(type) && item.sizeBytes <= TEXT_LIMIT) return "text";
  if (imageMimes.has(type) && item.sizeBytes <= IMAGE_LIMIT) return "image";
  if (ext === "xlsx" || ext === "docx" || ext === "pptx") return item.sizeBytes <= OOXML_LIMIT ? (ext === "xlsx" ? "table" : ext === "docx" ? "document" : "slides") : null;
  if (ext === "zip") return item.sizeBytes <= OOXML_LIMIT ? "archive" : null;
  if (ext === "pdf") return item.sizeBytes <= PDF_LIMIT ? "pdf" : null;
  if (["mp3", "wav", "ogg", "m4a", "mp4", "webm", "mov", "ogv"].includes(ext)) return item.sizeBytes <= MEDIA_LIMIT ? "media" : null;
  return null;
}

export type ArtifactPreview =
  | { kind: "text"; text: string; language?: string; file: FileDownload }
  | { kind: "image"; blob: Blob; file: FileDownload }
  | { kind: "table"; sheets: Array<{ name: string; rows: string[][]; rowCount: number; colCount: number }>; file: FileDownload }
  | { kind: "document"; text: string; pageCount?: number; file: FileDownload }
  | { kind: "slides"; slides: Array<{ title: string; text: string }>; slideCount: number; file: FileDownload }
  | { kind: "archive"; entries: Array<{ name: string; size: number }>; entryCount: number; file: FileDownload }
  | { kind: "pdf"; blob: Blob; file: FileDownload }
  | { kind: "media"; blob: Blob; mediaType: "audio" | "video"; file: FileDownload };

export function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0) throw new Error("Preview unavailable");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const dataLength = value.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    if (!(code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 48 && code <= 57 || code === 43 || code === 47)) throw new Error("Preview unavailable");
  }
  if (value.slice(dataLength).length !== padding || padding === 1 && dataLength % 4 !== 3 || padding === 2 && dataLength % 4 !== 2) throw new Error("Preview unavailable");
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

export function previewBlob(bytes: Uint8Array, type: string): Blob {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type });
}

function languageFor(ext: string): string | undefined {
  if (ext === "json") return "json";
  if (ext === "py") return "python";
  if (ext === "js") return "javascript";
  if (ext === "ts") return "typescript";
  if (ext === "tsx") return "tsx";
  if (ext === "jsx") return "jsx";
  if (ext === "css") return "css";
  if (ext === "sh") return "shellscript";
  if (ext === "sql") return "sql";
  if (ext === "go") return "go";
  if (ext === "rs") return "rust";
  if (ext === "java") return "java";
  if (ext === "c" || ext === "h") return "c";
  if (ext === "cpp" || ext === "hpp") return "cpp";
  if (ext === "yml" || ext === "yaml") return "yaml";
  if (ext === "toml") return "toml";
  if (ext === "log") return "log";
  if (ext === "xml") return "xml";
  return undefined;
}

export function decodePreview(item: LibraryItem, file: FileDownload): ArtifactPreview {
  const kind = previewKind(item);
  const type = mime(file.mimeType);
  const ext = extension(file.name);
  const itemExt = extension(item.name);
  const officeOctetStream = isOffice(itemExt) && ext === itemExt && type === "application/octet-stream" && compatible(file.name, mime(item.mimeType));
  if (!kind || ext !== itemExt || !compatible(file.name, type) && !officeOctetStream || mime(file.mimeType) !== mime(item.mimeType) && !officeOctetStream) throw new Error("Preview unavailable");
  const limit = kind === "image" ? IMAGE_LIMIT : kind === "table" || kind === "document" || kind === "slides" || kind === "archive" ? OOXML_LIMIT : kind === "pdf" ? PDF_LIMIT : kind === "media" ? MEDIA_LIMIT : TEXT_LIMIT;
  if (file.contentBase64.length > Math.ceil(limit / 3) * 4 + 4) throw new Error("Preview unavailable");
  const bytes = decodeBase64(file.contentBase64);
  if (bytes.byteLength > limit || (file.sizeBytes !== undefined && file.sizeBytes !== bytes.byteLength)) throw new Error("Preview unavailable");
  if (kind === "image") return { kind, blob: previewBlob(bytes, type), file };
  if (kind === "pdf") {
    if (bytes.length < 5 || !bytes.subarray(0, 5).every((value, index) => value === [0x25, 0x50, 0x44, 0x46, 0x2d][index])) throw new Error("Preview unavailable");
    return { kind, blob: previewBlob(bytes, type), file };
  }
  if (kind === "media") {
    if (!hasMediaSignature(bytes, type)) throw new Error("Preview unavailable");
    return { kind, blob: previewBlob(bytes, type), mediaType: type.startsWith("video/") ? "video" : "audio", file };
  }
  if (kind === "archive") {
    if (!isZip(bytes)) throw new Error("Preview unavailable");
    const entries = archiveEntries(bytes);
    return { kind, entries, entryCount: entries.length, file };
  }
  if (kind === "table" && ext === "csv") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    const rows = parseCsv(text);
    return { kind, sheets: [{ name: "Sheet1", rows, rowCount: rows.length, colCount: rows.reduce((max, row) => Math.max(max, row.length), 0) }], file };
  }
  if (kind === "table" || kind === "document" || kind === "slides") {
    if (!isZip(bytes)) throw new Error("Preview unavailable");
    validateOfficeArchive(bytes);
    const contents = unzipSync(bytes, { filter: (entry) => officeXmlPath(ext, entry.name) });
    return { ...officePreview(ext, contents), file };
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  return { kind, text, ...(languageFor(ext) ? { language: languageFor(ext) } : {}), file };
}

function officeXmlPath(ext: string, path: string): boolean {
  if (path === "[Content_Types].xml" || path === "xl/workbook.xml" || path === "xl/_rels/workbook.xml.rels" || path === "word/document.xml" || path === "ppt/presentation.xml" || path === "ppt/_rels/presentation.xml.rels") return true;
  if (ext === "xlsx") return /^xl\/worksheets\/sheet\d+\.xml$/.test(path) || path === "xl/sharedStrings.xml";
  if (ext === "pptx") return /^ppt\/slides\/slide\d+\.xml$/.test(path);
  return false;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else cell += char;
      continue;
    }
    if (char === '"' && cell.length === 0 && !closedQuote) { quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; closedQuote = false; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = ""; closedQuote = false; continue;
    }
    if (closedQuote) throw new Error("Preview unavailable");
    cell += char;
  }
  if (quoted) throw new Error("Preview unavailable");
  if (cell.length || row.length || !rows.length || closedQuote) { row.push(cell); rows.push(row); }
  return rows;
}

function hasMediaSignature(bytes: Uint8Array, type: string): boolean {
  if (type === "audio/mpeg") return bytes.length >= 3 && (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 || bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0);
  if (type === "audio/wav" || type === "audio/x-wav") return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE";
  if (type === "audio/ogg" || type === "video/ogg" || type === "audio/webm" || type === "video/webm") return bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === (type.includes("ogg") ? "OggS" : "\u001aE\xdf\xa3");
  if (type === "audio/mp4" || type === "video/mp4" || type === "video/quicktime") return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp";
  return false;
}

export function fileFormat(name: string): string {
  const ext = extension(name);
  if (ext === "md") return "Markdown";
  if (ext === "txt") return "Text document";
  if (ext === "xlsx") return "Excel workbook";
  if (ext === "docx") return "Word document";
  if (ext === "pptx") return "PowerPoint presentation";
  if (ext === "zip") return "ZIP archive";
  if (ext === "pdf") return "PDF document";
  return ext && ext !== name.toLowerCase() ? ext.toUpperCase() : "File";
}

/** A faithful readable excerpt, not an invented document cover. */
export function documentExcerpt(text: string): { title: string; body: string } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const clean = (line: string) => line.replace(/^#{1,6}\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");
  return { title: clean(lines[0] ?? "Empty document"), body: lines.slice(1, 5).map(clean).join("\n") };
}
