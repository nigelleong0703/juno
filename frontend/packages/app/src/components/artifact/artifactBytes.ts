import type { ApiClient, ArtifactPart, FileDownload, LibraryItem } from "@agent-desktop/client";
import { useEffect, useState, type RefObject } from "react";
import { decodeBase64, previewBlob } from "../conversation/artifactPreview";

/**
 * One file's bytes through the authenticated client: a published version's part (file, preview or thumbnail) when the
 * item is published, otherwise the library download. Never a bare URL.
 */
export function loadItemFile(client: ApiClient, item: LibraryItem, version: number | undefined, part: ArtifactPart = "file"): Promise<FileDownload> {
  if (item.render && version !== undefined) return client.artifacts.download(item.id, version, part);
  return client.library.download(item.id);
}

/** The bytes as a Blob of their own media type. */
export function fileBlob(file: FileDownload): Blob {
  return previewBlob(decodeBase64(file.contentBase64), file.mimeType);
}

/** An object URL for a blob, revoked when the blob changes or the component goes away. */
export function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/** True once the element has been on screen (or immediately where IntersectionObserver is missing). */
export function useEverInView(ref: RefObject<HTMLElement | null>, rootMargin = "240px"): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (seen || !el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    }, { rootMargin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, seen, rootMargin]);
  return seen;
}
