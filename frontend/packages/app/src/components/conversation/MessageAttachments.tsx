import type { LibraryItem } from "@agent-desktop/client";
import { cn, toast } from "@agent-desktop/ui";
import { useQuery } from "@tanstack/react-query";
import { FileText, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useClient } from "../../data/ClientProvider";
import { formatBytes } from "../../lib/format";
import type { UserMessageItem } from "../../lib/items";
import { ArtifactViewer } from "../artifact/ArtifactViewer";
import { fileBlob, useObjectUrl } from "../artifact/artifactBytes";

type Attachment = UserMessageItem["attachments"][number];

export function isPhoto(attachment: Attachment): boolean {
  return attachment.kind === "image" || (attachment.mimeType ?? "").startsWith("image/");
}

/** The square a photo is drawn in, as on the iPhone: one alone large, two side by side, three or more three a row. */
function photoSide(count: number): number {
  return count === 1 ? 220 : count === 2 ? 132 : 88;
}

/**
 * What a message carries, above its text as on the iPhone: photos as themselves, other files as cards. Either opens
 * in the file viewer.
 */
export function MessageAttachments({ attachments, align }: { attachments: Attachment[]; align: "start" | "end" }) {
  const client = useClient();
  const [opening, setOpening] = useState<string | null>(null);
  const [open, setOpen] = useState<LibraryItem | null>(null);
  const photos = attachments.filter(isPhoto);
  const files = attachments.filter((attachment) => !isPhoto(attachment));

  async function view(attachment: Attachment): Promise<void> {
    if (opening) return;
    setOpening(attachment.id);
    try {
      setOpen(await client.library.get(attachment.id));
    } catch {
      toast("Could not open the file", { description: "Try again." });
    } finally {
      setOpening(null);
    }
  }

  if (attachments.length === 0) return null;
  const side = photoSide(photos.length);
  return (
    <>
      {photos.length > 0 ? (
        <div
          className={cn("grid gap-1", align === "end" ? "justify-end" : "justify-start")}
          style={{ gridTemplateColumns: `repeat(${Math.min(photos.length, 3)}, ${side}px)` }}
        >
          {photos.map((photo) => (
            <Photo key={photo.id} attachment={photo} side={side} onOpen={() => void view(photo)} />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? (
        <div className={cn("flex flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start")}>
          {files.map((file) => (
            <button
              key={file.id}
              type="button"
              onClick={() => void view(file)}
              className="flex max-w-72 items-center gap-2.5 rounded-2xl border border-border bg-surface py-2 pl-2.5 pr-3.5 text-left transition-colors hover:bg-bg-subtle focus-ring"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-fg-muted">
                {opening === file.id ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-fg" title={file.name}>
                  {file.name}
                </span>
                <span className="block text-xs text-fg-subtle">
                  {[extension(file.name), file.sizeBytes === undefined ? "" : formatBytes(file.sizeBytes)].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {open ? <ArtifactViewer item={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : "";
}

function Photo({ attachment, side, onOpen }: { attachment: Attachment; side: number; onOpen: () => void }) {
  const client = useClient();
  const file = useQuery({
    queryKey: ["attachment-photo", attachment.id],
    queryFn: () => client.library.download(attachment.id),
    staleTime: Infinity,
    retry: false,
  });
  const blob = useMemo(() => (file.data ? fileBlob(file.data) : undefined), [file.data]);
  const url = useObjectUrl(blob);
  return (
    <button
      type="button"
      aria-label={attachment.name}
      onClick={onOpen}
      style={{ width: side, height: side }}
      className="grid place-items-center overflow-hidden rounded-2xl border border-border bg-muted focus-ring"
    >
      {url ? (
        <img src={url} alt="" className="size-full object-cover" />
      ) : file.isError ? (
        <span className="px-2 text-center text-xs text-fg-subtle">{attachment.name}</span>
      ) : (
        <Loader2 className="size-4 animate-spin text-fg-subtle" />
      )}
    </button>
  );
}
