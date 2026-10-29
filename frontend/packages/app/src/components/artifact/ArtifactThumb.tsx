import type { LibraryItem } from "@agent-desktop/client";
import { FileIcon, cn } from "@agent-desktop/ui";
import { useQuery } from "@tanstack/react-query";
import { AppWindow, Film, FileText, Image as ImageIcon, LayoutTemplate } from "lucide-react";
import { useRef } from "react";
import { useClient } from "../../data/ClientProvider";
import { fileBlob, loadItemFile, useEverInView, useObjectUrl } from "./artifactBytes";
import { latestVersion, thumbnailSource, viewerKind } from "./artifactKind";

/** Longest edge of a picture cut for a grid cell; the browser scales it down to the cell. */
const THUMB_EDGE = 480;

/**
 * An image made smaller before it is kept: a bitmap drawn at most {@link THUMB_EDGE} px on its longest edge. Any
 * failure (no canvas, an SVG the bitmap decoder refuses) keeps the original bytes.
 */
async function downscaled(blob: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return blob;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>((resolve) => canvas.toBlob((out) => resolve(out ?? blob), "image/webp", 0.85));
  } catch {
    return blob;
  }
}

/** The render type's icon, shown in the cell when there is no picture. */
export function ArtifactGlyph({ item, className }: { item: LibraryItem; className?: string }) {
  const kind = viewerKind(item);
  const iconClass = cn("size-7", className);
  if (item.render === "doc") return <FileText aria-hidden="true" className={iconClass} />;
  switch (kind) {
    case "page":
      return <LayoutTemplate aria-hidden="true" className={iconClass} />;
    case "space":
      return <AppWindow aria-hidden="true" className={iconClass} />;
    case "video":
      return <Film aria-hidden="true" className={iconClass} />;
    case "image":
      return <ImageIcon aria-hidden="true" className={iconClass} />;
    default:
      return <FileIcon name={item.name} size={28} />;
  }
}

/**
 * The picture of one item, loaded only once it is on screen: the version's first-page thumbnail, else the image itself
 * (downscaled), else the render type's icon on the neutral muted surface. Used by Library cells, chat cards and the
 * viewer's loading cover.
 */
export function ArtifactThumb({ item, className, fit = "cover" }: { item: LibraryItem; className?: string; fit?: "cover" | "contain" }) {
  const client = useClient();
  const ref = useRef<HTMLDivElement>(null);
  const visible = useEverInView(ref);
  const source = thumbnailSource(item);
  const version = latestVersion(item)?.version ?? item.version;
  const query = useQuery({
    queryKey: ["artifact-thumb", item.id, item.updatedAt, source, version ?? 0],
    enabled: visible && source !== "none",
    retry: false,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    queryFn: async (): Promise<Blob> => {
      if (source === "thumbnail") return fileBlob(await client.artifacts.download(item.id, version ?? 1, "thumbnail"));
      return downscaled(fileBlob(await loadItemFile(client, item, version)));
    },
  });
  const url = useObjectUrl(query.data);
  return (
    <div ref={ref} data-slot="artifact-thumb" data-source={url ? source : "none"} className={cn("relative flex items-center justify-center overflow-hidden bg-muted text-fg-subtle", className)}>
      {url ? (
        <img src={url} alt="" className={cn("size-full", fit === "cover" ? "object-cover object-top" : "object-contain")} />
      ) : (
        <ArtifactGlyph item={item} />
      )}
    </div>
  );
}
