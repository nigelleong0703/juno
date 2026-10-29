const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const MAX_ENTRY_SIZE = 1024 * 1024;
const MAX_XML_SIZE = 8 * 1024 * 1024;
const MAX_ENTRIES = 2048;
type ZipEntry = { name: string; size: number; compressedSize: number; flags: number };
type OfficeResult =
  | { kind: "table"; sheets: Array<{ name: string; rows: string[][]; rowCount: number; colCount: number }> }
  | { kind: "document"; text: string }
  | { kind: "slides"; slides: Array<{ title: string; text: string }>; slideCount: number };

function fail(): never { throw new Error("Preview unavailable"); }

function readDirectory(bytes: Uint8Array, office = false): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === END_SIGNATURE) { end = offset; break; }
  }
  if (end < 0) return fail();
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const diskCount = view.getUint16(end + 8, true);
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (disk || centralDisk || diskCount !== count || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) return fail();
  if (centralOffset + centralSize > end || centralOffset > bytes.length) return fail();
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let xmlTotal = 0;
  let compressedTotal = 0;
  if (count > MAX_ENTRIES) return fail();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > centralOffset + centralSize || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) return fail();
    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const startDisk = view.getUint16(offset + 34, true);
    const localOffset = view.getUint32(offset + 42, true);
    const fullLength = 46 + nameLength + extraLength + commentLength;
    if (offset + fullLength > centralOffset + centralSize || flags & 1 || startDisk || size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) return fail();
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || names.has(name)) return fail();
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) return fail();
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags || localMethod !== view.getUint16(offset + 10, true) || dataOffset + compressedSize > centralOffset) return fail();
    if (!(flags & 8) && (view.getUint32(localOffset + 18, true) !== compressedSize || view.getUint32(localOffset + 22, true) !== size)) return fail();
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength));
    if (localName !== name) return fail();
    let extraOffset = offset + 46 + nameLength;
    const extraEnd = extraOffset + extraLength;
    while (extraOffset < extraEnd) {
      if (extraOffset + 4 > extraEnd) return fail();
      const extraId = view.getUint16(extraOffset, true);
      const fieldLength = view.getUint16(extraOffset + 2, true);
      if (extraId === 1 || extraOffset + 4 + fieldLength > extraEnd) return fail();
      extraOffset += 4 + fieldLength;
    }
    names.add(name);
    compressedTotal += compressedSize;
    if (compressedTotal > 8 * 1024 * 1024) return fail();
    if (office && name.toLowerCase().endsWith(".xml")) {
      xmlTotal += size;
      if (size > MAX_ENTRY_SIZE || xmlTotal > MAX_XML_SIZE) return fail();
    }
    entries.push({ name, size, compressedSize, flags });
    offset += fullLength;
  }
  if (offset !== centralOffset + centralSize) return fail();
  return entries;
}

export function archiveEntries(bytes: Uint8Array): Array<{ name: string; size: number }> {
  return readDirectory(bytes).filter((entry) => !entry.name.endsWith("/")).map(({ name, size }) => ({ name, size }));
}

function parseXml(xml: string): XMLDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return fail();
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length) return fail();
  return document;
}

function xmlNodes(xml: string, localName: string): Element[] {
  return Array.from(parseXml(xml).getElementsByTagNameNS("*", localName));
}

function xmlText(xml: string, localName: string): string[] {
  return xmlNodes(xml, localName).map((node) => node.textContent ?? "");
}

function partText(contents: Record<string, Uint8Array>, path: string): string {
  const bytes = contents[path];
  if (!bytes || bytes.byteLength > MAX_ENTRY_SIZE) return fail();
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function sharedStrings(xml: string): string[] {
  return xmlNodes(xml, "si").map((item) => Array.from(item.getElementsByTagNameNS("*", "t")).map((node) => node.textContent ?? "").join(""));
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function worksheet(xml: string, strings: string[]): string[][] {
  const rows: string[][] = [];
  let cellCount = 0;
  let allocatedCells = 0;
  for (const rowNode of xmlNodes(xml, "row")) {
    if (rows.length >= 20_000) return fail();
    const cells: string[] = [];
    for (const cellNode of Array.from(rowNode.getElementsByTagNameNS("*", "c"))) {
      cellCount += 1;
      const ref = cellNode.getAttribute("r") || "A1";
      const column = columnIndex(ref);
      if (column > 16_383) return fail();
      allocatedCells += Math.max(0, column + 1 - cells.length);
      if (cellCount > 20_000 || allocatedCells > 50_000) return fail();
      while (cells.length <= column) cells.push("");
      const type = cellNode.getAttribute("t");
      const value = type === "inlineStr"
        ? Array.from(cellNode.getElementsByTagNameNS("*", "t")).map((node) => node.textContent ?? "").join("")
        : cellNode.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
      cells[column] = type === "s" ? strings[Number(value)] ?? "" : value;
    }
    rows.push(cells);
  }
  return rows;
}

function workbook(contents: Record<string, Uint8Array>): OfficeResult {
  const xml = partText(contents, "xl/workbook.xml");
  const sheetNames = xmlNodes(xml, "sheet").map((sheet) => ({
    name: sheet.getAttribute("name") || "Sheet",
    id: sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || sheet.getAttribute("r:id"),
  }));
  const rels = partText(contents, "xl/_rels/workbook.xml.rels");
  const targets = new Map(xmlNodes(rels, "Relationship").map((relation) => [relation.getAttribute("Id"), relation.getAttribute("Target")]));
  const shared = contents["xl/sharedStrings.xml"] ? sharedStrings(partText(contents, "xl/sharedStrings.xml")) : [];
  const sheets = sheetNames.map(({ name, id }) => {
    const target = targets.get(id);
    if (!target) return fail();
    const path = packageTarget(target, "xl");
    if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(path)) return fail();
    const rows = worksheet(partText(contents, path), shared);
    return { name, rows, rowCount: rows.length, colCount: rows.reduce((max, row) => Math.max(max, row.length), 0) };
  });
  if (!sheets.length) return fail();
  return { kind: "table", sheets };
}

function document(contents: Record<string, Uint8Array>): OfficeResult {
  const xml = partText(contents, "word/document.xml");
  const paragraphs = xmlNodes(xml, "p").map((paragraph) => Array.from(paragraph.getElementsByTagNameNS("*", "t")).map((node) => node.textContent ?? "").join(""));
  const text = xmlText(xml, "t").join("");
  return { kind: "document", text: paragraphs.filter(Boolean).join("\n") || text };
}

function presentation(contents: Record<string, Uint8Array>): OfficeResult {
  const slideFiles = Object.keys(contents).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  let names = slideFiles.sort((left, right) => Number(left.match(/slide(\d+)/)?.[1]) - Number(right.match(/slide(\d+)/)?.[1]));
  if (contents["ppt/presentation.xml"]) {
    const presentationXml = partText(contents, "ppt/presentation.xml");
    const slideList = xmlNodes(presentationXml, "sldIdLst")[0];
    const ids = slideList ? Array.from(slideList.children).filter((child) => child.localName === "sldId").map((child) => child.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") || child.getAttribute("r:id")) : [];
    const relations = xmlNodes(partText(contents, "ppt/_rels/presentation.xml.rels"), "Relationship");
    const targets = new Map(relations.map((relation) => [relation.getAttribute("Id"), relation.getAttribute("Target")]));
    names = ids.map((id) => {
      const target = targets.get(id);
      if (!target) return fail();
      const path = packageTarget(target, "ppt");
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(path) || !slideFiles.includes(path)) return fail();
      return path;
    });
  }
  if (!names.length) return fail();
  const slides = names.map((name) => {
    const xml = partText(contents, name);
    const values = xmlText(xml, "t");
    const text = values.join(" ").trim();
    const titleShape = xmlNodes(xml, "sp").find((shape) => Array.from(shape.getElementsByTagNameNS("*", "ph")).some((placeholder) => {
      const placeholderType = placeholder.getAttribute("type");
      return placeholderType === "title" || placeholderType === "ctrTitle";
    }));
    const title = titleShape ? Array.from(titleShape.getElementsByTagNameNS("*", "t")).map((node) => node.textContent ?? "").join(" ").trim() : values[0] ?? "";
    return { title, text };
  });
  return { kind: "slides", slides, slideCount: slides.length };
}

function packageTarget(target: string, base: string): string {
  if (!target || target.includes("\\") || target.includes(":") || target.includes("?") || target.includes("#") || target.startsWith("//")) return fail();
  const absolute = target.startsWith("/");
  const parts = absolute ? [] : [base];
  for (const part of target.replace(/^\/+/, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return fail();
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function officePreview(ext: string, contents: Record<string, Uint8Array>): OfficeResult {
  if (ext === "xlsx") return workbook(contents);
  if (ext === "docx") return document(contents);
  if (ext === "pptx") return presentation(contents);
  return fail();
}

export function validateOfficeArchive(bytes: Uint8Array): void {
  readDirectory(bytes, true);
}
