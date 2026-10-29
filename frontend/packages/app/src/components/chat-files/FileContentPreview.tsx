import type { LibraryItem } from "@agent-desktop/client";
import { Button, Markdown } from "@agent-desktop/ui";
import { ChevronLeft, ChevronRight, FileArchive, FileAudio, FileVideo } from "lucide-react";
import { useState } from "react";
import { PdfFilePreview } from "./PdfFilePreview";
import { useFilePreview } from "./useFilePreview";

export interface FileContentPreviewProps {
  item: LibraryItem;
}

function textPreview(text: string, name: string, language: string | undefined) {
  if (name.toLowerCase().endsWith(".md")) {
    return <Markdown allowMedia={false} className="break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto">{text}</Markdown>;
  }
  if (language || name.toLowerCase().endsWith(".json")) {
    return <pre className="max-w-full overflow-hidden whitespace-pre-wrap break-words font-mono text-xs leading-5 text-fg-muted">{text}</pre>;
  }
  return <pre className="max-w-full whitespace-pre-wrap break-words font-sans text-sm leading-5 text-fg-muted">{text}</pre>;
}

function slideBody(text: string, title: string): string {
  const trimmed = text.trimStart();
  return trimmed.startsWith(title) ? trimmed.slice(title.length).trimStart() : trimmed;
}

function TablePreview({ sheets }: { sheets: Array<{ name: string; rows: string[][]; rowCount: number; colCount: number }> }) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = sheets[sheetIndex];
  if (!sheet) return <p className="text-sm text-fg-muted">This spreadsheet contains no previewable rows.</p>;
  const rows = sheet.rows.slice(0, 200);
  const columnLimit = 50;
  const shownRows = rows.map((row) => row.slice(0, columnLimit));
  const shownColumns = Math.min(sheet.colCount, columnLimit);
  return (
    <div className="min-w-0">
      {sheets.length > 1 && (
        <div className="mb-3 flex items-center justify-between gap-2">
          <Button variant="ghost" size="icon" aria-label="Previous sheet" disabled={sheetIndex === 0} onClick={() => setSheetIndex((index) => index - 1)}><ChevronLeft className="size-4" /></Button>
          <p className="min-w-0 truncate text-sm font-medium text-fg">{sheet.name} <span className="font-normal text-fg-subtle">({sheetIndex + 1} of {sheets.length})</span></p>
          <Button variant="ghost" size="icon" aria-label="Next sheet" disabled={sheetIndex === sheets.length - 1} onClick={() => setSheetIndex((index) => index + 1)}><ChevronRight className="size-4" /></Button>
        </div>
      )}
      <div className="max-w-full overflow-auto">
        <table className="w-full border-collapse text-left text-xs">
          <tbody>
            {shownRows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border/60">
                {row.map((cell, columnIndex) => <td key={columnIndex} className={`max-w-64 whitespace-pre-wrap break-words px-2 py-2 ${rowIndex === 0 ? "bg-bg-subtle font-semibold text-fg" : "text-fg-muted"}`}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[11px] text-fg-subtle">Showing {rows.length} of {sheet.rowCount} rows · first {shownColumns} of {sheet.colCount} columns</p>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "Duration unavailable";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}` : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function MediaPreview({ src, mediaType }: { src: string; mediaType: "audio" | "video" }) {
  const [duration, setDuration] = useState<string | null>(null);
  const [error, setError] = useState(false);
  if (error) return <p role="alert" className="flex items-center gap-2 text-xs text-fg-subtle">{mediaType === "audio" ? <FileAudio aria-hidden="true" className="size-5 shrink-0" /> : <FileVideo aria-hidden="true" className="size-5 shrink-0" />}This media format cannot be played here. Download the file to view it.</p>;
  if (mediaType === "audio") return <div className="w-full">
    <FileAudio aria-hidden="true" className="size-8 shrink-0 text-fg-muted" />
    <div className="min-w-0 flex-1"><p className="text-xs text-fg-muted">{duration ?? "Audio preview"}</p><audio className="mt-2 w-full" controls preload="metadata" src={src} onLoadedMetadata={(event) => setDuration(formatDuration(event.currentTarget.duration))} onError={() => setError(true)} /></div>
  </div>;
  return <div><video controls preload="metadata" src={src} className="max-h-[65vh] w-full" onLoadedMetadata={(event) => setDuration(formatDuration(event.currentTarget.duration))} onError={() => setError(true)} />{duration && <p className="mt-2 text-xs text-fg-subtle">Duration {duration}</p>}</div>;
}

/** The authenticated, cached contents of a plain file (text, table, document, slides, archive, PDF, image or media). */
export function FileContentPreview({ item }: FileContentPreviewProps) {
  const { preview, isLoading, isError, objectUrl } = useFilePreview(item);
  if (isLoading) return <p className="text-xs text-fg-subtle">Loading preview…</p>;
  if (isError || !preview) return <p className="text-sm text-fg-subtle">Preview unavailable for this file. Download it to view the contents.</p>;
  if (preview.kind === "text") return textPreview(preview.text, item.name, preview.language);
  if (preview.kind === "image") return objectUrl ? <img src={objectUrl} alt={item.name} className="h-auto max-w-full" /> : null;
  if (preview.kind === "table") return <TablePreview sheets={preview.sheets} />;
  if (preview.kind === "document") return <section aria-label="Document text preview"><p className="mb-2 text-xs font-medium text-fg-subtle">Document text preview{preview.pageCount === undefined ? "" : ` · ${preview.pageCount} pages`}</p>{textPreview(preview.text, "document.txt", undefined)}</section>;
  if (preview.kind === "slides") {
    return <div className="space-y-5"><p className="text-xs font-medium text-fg-subtle">Slide text preview · {preview.slides.length} of {preview.slideCount} slides</p>{preview.slides.map((slide, index) => { const body = slideBody(slide.text, slide.title); return <section key={index} className="border-b border-border/60 pb-4"><h3 className="mb-2 text-sm font-semibold text-fg">{slide.title || `Slide ${index + 1}`}</h3><p className="whitespace-pre-wrap text-sm text-fg-muted">{body || "No readable text on this slide."}</p></section>; })}</div>;
  }
  if (preview.kind === "archive") return <div className="min-w-0"><div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg"><FileArchive className="size-4" />{preview.entryCount} entries</div><ul className="space-y-1 text-xs text-fg-muted">{preview.entries.map((entry) => <li key={entry.name} className="flex justify-between gap-3"><span className="truncate">{entry.name}</span><span className="shrink-0">{entry.size.toLocaleString()} B</span></li>)}</ul></div>;
  if (preview.kind === "pdf") return <PdfFilePreview blob={preview.blob} />;
  if (preview.kind === "media") {
    if (!objectUrl) return null;
    return <MediaPreview key={objectUrl} src={objectUrl} mediaType={preview.mediaType} />;
  }
  return null;
}
