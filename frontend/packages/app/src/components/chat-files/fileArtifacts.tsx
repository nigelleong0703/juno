import type { FileDownload } from "@agent-desktop/client";

/** Basename without directories so the download anchor cannot escape the download folder. */
export function safeBasename(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? "";
  return base || "download";
}

/** Save an authenticated download payload through a DOM anchor (same HTTP request, not a URL). */
export function saveDownload(file: FileDownload): void {
  const bytes = Uint8Array.from(atob(file.contentBase64), (ch) => ch.charCodeAt(0));
  const blob = new Blob([bytes], { type: file.mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeBasename(file.name);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Chrome resolves the download from the object URL after click: keep it alive a full
  // minute so large files still start, then release the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
