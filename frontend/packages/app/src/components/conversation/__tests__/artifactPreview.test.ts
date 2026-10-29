import type { FileDownload, LibraryItem } from "@agent-desktop/client";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { decodePreview, previewKind } from "../artifactPreview";

const officeTypes = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function item(name: string, mimeType: string, sizeBytes = 100): LibraryItem {
  return {
    id: "lib-file", name, mimeType, sizeBytes, kind: "file", shared: "private",
    source: "upload", tags: [], pinned: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function download(name: string, mimeType: string, bytes: Uint8Array): FileDownload {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { name, mimeType, contentBase64: btoa(binary), sizeBytes: bytes.length };
}

function archive(parts: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, new TextEncoder().encode(text)])));
}

describe("file format previews", () => {
  it("parses UTF-8 CSV quoting, embedded newlines, escaped quotes, and BOM", () => {
    const csv = "\uFEFFName,Note\r\n\"陈\",\"first line\nsecond line\"\r\n\"a\"\"b\",ok";
    const artifact = item("people.csv", "text/csv", new TextEncoder().encode(csv).length);
    const result = decodePreview(artifact, download(artifact.name, artifact.mimeType, new TextEncoder().encode(csv)));
    expect(result.kind).toBe("table");
    if (result.kind !== "table") throw new Error("Expected CSV table");
    expect(result.sheets[0]?.rows).toEqual([["Name", "Note"], ["陈", "first line\nsecond line"], ['a"b', "ok"]]);
    expect(result.sheets[0]?.rowCount).toBe(3);
    expect(result.sheets[0]?.colCount).toBe(2);
    expect(previewKind(artifact)).toBe("table");
  });

  it("returns real JSON and source text with a language hint", () => {
    const json = '{"ok":true,"city":"東京"}';
    const file = download("data.json", "application/json", new TextEncoder().encode(json));
    const result = decodePreview(item("data.json", "application/json", file.sizeBytes ?? 0), file);
    expect(result).toMatchObject({ kind: "text", text: json, language: "json" });
  });

  it("reads workbook cell values and sheet names from zipped OOXML", () => {
    const bytes = archive({
      "[Content_Types].xml": "<Types/>",
      "xl/workbook.xml": '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet r:id="rId1" name="Sales"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Target="/xl/worksheets/sheet1.xml" Id="rId1"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>商品</t></si><si><t>東京</t></si></sst>",
      "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>椅子</t></is></c><c r="B2"><v>12</v></c></row></sheetData></worksheet>',
      "xl/media/ignored.xml": "<payload>ignored</payload>",
    });
    const artifact = item("sales.xlsx", officeTypes.xlsx, bytes.length);
    expect(previewKind(artifact)).toBe("table");
    const result = decodePreview(artifact, download(artifact.name, artifact.mimeType, bytes));
    expect(result.kind).toBe("table");
    if (result.kind !== "table") throw new Error("Expected workbook table");
    expect(result.sheets).toEqual([{ name: "Sales", rows: [["商品", "東京"], ["椅子", "12"]], rowCount: 2, colCount: 2 }]);
  });

  it("accepts a ZIP-backed octet-stream Office download and bounds source previews", () => {
    const bytes = archive({
      "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Real text</w:t></w:r></w:p></w:body></w:document>',
      "word/media/picture.png": "ignored binary",
    });
    const metadata = item("report.docx", officeTypes.docx, bytes.length);
    const officeDownload = download(metadata.name, "application/octet-stream", bytes);
    expect(decodePreview(metadata, officeDownload)).toMatchObject({ kind: "document", text: "Real text" });
    expect(previewKind(item("component.tsx", "text/plain", 20))).toBe("text");
    expect(decodePreview(item("component.tsx", "text/plain", 20), download("component.tsx", "text/plain", new TextEncoder().encode("const App = () => null")))).toMatchObject({ kind: "text", language: "tsx" });
    expect(previewKind(item("page.html", "text/plain"))).toBeNull();
  });

  it("extracts DOCX paragraphs and numerically ordered PPTX slide text", () => {
    const docx = archive({ "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>Second &amp; final</w:t></w:r></w:p></w:body></w:document>' });
    const document = decodePreview(item("note.docx", officeTypes.docx, docx.length), download("note.docx", officeTypes.docx, docx));
    expect(document).toMatchObject({ kind: "document", text: "第一段\nSecond & final" });

    const pptx = archive({
      "ppt/slides/slide10.xml": '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Ten</a:t><a:t>later</a:t></p:sld>',
      "ppt/slides/slide2.xml": '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Two</a:t></p:sld>',
    });
    const slides = decodePreview(item("deck.pptx", officeTypes.pptx, pptx.length), download("deck.pptx", officeTypes.pptx, pptx));
    expect(slides).toMatchObject({ kind: "slides", slideCount: 2, slides: [{ title: "Two", text: "Two" }, { title: "Ten", text: "Ten later" }] });
  });

  it("orders PPTX slides by presentation relationships and reads the semantic title shape", () => {
    const pptx = archive({
      "ppt/presentation.xml": '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId10"/><p:sldId r:id="rId2"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Target="slides/slide2.xml" Id="rId10"/><Relationship Target="slides/slide10.xml" Id="rId2"/></Relationships>',
      "ppt/slides/slide10.xml": '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Semantic title</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>Body copy</a:t></a:r></a:p></p:txBody></p:sp></p:sld>',
      "ppt/slides/slide2.xml": '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:sp><p:txBody><a:p><a:r><a:t>First in deck</a:t></a:r></a:p></p:txBody></p:sp></p:sld>',
    });
    const result = decodePreview(item("ordered.pptx", officeTypes.pptx, pptx.length), download("ordered.pptx", officeTypes.pptx, pptx));
    expect(result).toMatchObject({ kind: "slides", slideCount: 2, slides: [{ title: "First in deck", text: "First in deck" }, { title: "Semantic title", text: "Semantic title Body copy" }] });
  });

  it("lists ZIP central-directory entries without exposing file contents", () => {
    const bytes = zipSync({ "notes.txt": new TextEncoder().encode("secret body"), "nested/data.json": new TextEncoder().encode("{}") });
    const artifact = item("bundle.zip", "application/octet-stream", bytes.length);
    expect(previewKind(artifact)).toBe("archive");
    const result = decodePreview(artifact, download(artifact.name, artifact.mimeType, bytes));
    expect(result.kind).toBe("archive");
    if (result.kind !== "archive") throw new Error("Expected ZIP listing");
    expect(result.entries).toEqual([{ name: "notes.txt", size: 11 }, { name: "nested/data.json", size: 2 }]);
    expect(result).not.toHaveProperty("text");
  });

  it("rejects MIME mismatches, unsupported legacy office files, oversized files, and truncated ZIPs", () => {
    expect(previewKind(item("page.html", "text/plain"))).toBeNull();
    expect(previewKind(item("old.xls", "application/vnd.ms-excel"))).toBeNull();
    expect(previewKind(item("large.pdf", "application/pdf", 10 * 1024 * 1024 + 1))).toBeNull();
    const csvItem = item("rows.csv", "text/csv", 1);
    expect(() => decodePreview(csvItem, download("rows.csv", "application/json", new TextEncoder().encode("[]")))).toThrow();
    const xlsx = archive({ "xl/workbook.xml": "<workbook/>", "xl/_rels/workbook.xml.rels": "<Relationships/>" });
    const broken = xlsx.subarray(0, xlsx.length - 9);
    const officeItem = item("bad.xlsx", officeTypes.xlsx, broken.length);
    expect(() => decodePreview(officeItem, download(officeItem.name, officeItem.mimeType, broken))).toThrow();
    const shortPdf = item("short.pdf", "application/pdf", 2);
    expect(() => decodePreview(shortPdf, download(shortPdf.name, shortPdf.mimeType, new Uint8Array([0x25, 0x50])))).toThrow();
  });

  it("rejects unsafe OOXML declarations and enforces compressed and expanded bounds", () => {
    const declared = archive({ "word/document.xml": '<!DOCTYPE x [<!ENTITY a "boom">]><w:document>&a;</w:document>' });
    const unsafeItem = item("unsafe.docx", officeTypes.docx, declared.length);
    expect(() => decodePreview(unsafeItem, download(unsafeItem.name, unsafeItem.mimeType, declared))).toThrow();

    const compressed = archive({ "word/document.xml": "x".repeat(8 * 1024 * 1024 + 1) });
    const expandedItem = item("expanded.docx", officeTypes.docx, compressed.length);
    expect(() => decodePreview(expandedItem, download(expandedItem.name, expandedItem.mimeType, compressed))).toThrow();
  });

  it("decodes a valid 10-million-character Base64 PDF without regex backtracking", () => {
    const bytes = new Uint8Array(7_500_000);
    bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const artifact = item("large-valid.pdf", "application/pdf", bytes.length);
    const result = decodePreview(artifact, download(artifact.name, artifact.mimeType, bytes));
    expect(result.kind).toBe("pdf");
    if (result.kind !== "pdf") throw new Error("Expected PDF");
    expect(result.blob.size).toBe(bytes.length);
  });
});
