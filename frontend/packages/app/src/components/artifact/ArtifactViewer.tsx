import type { LibraryItem, Space } from "@agent-desktop/client";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
  cn,
  toast,
} from "@agent-desktop/ui";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Download, Loader2, Share2, X } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from "react";
import { useClient } from "../../data/ClientProvider";
import { saveDownload, safeBasename } from "../chat-files/fileArtifacts";
import { SpaceShareDialog } from "../conversation/SpaceShareDialog";
import { ArtifactThumb } from "./ArtifactThumb";
import { DocumentBody, FileBody, ImageBody, PageBody, SpaceBody, VideoBody, type ViewerBodyProps } from "./ArtifactBodies";
import { fileBlob, loadItemFile } from "./artifactBytes";
import { latestVersion, viewerKind, type ViewerKind } from "./artifactKind";

const DocumentViewer = lazy(() => import("../document/DocumentViewer").then((module) => ({ default: module.DocumentViewer })));

/** How often an open Space re-checks its status (the check never wakes the computer). */
export const SPACE_POLL_MS = 20_000;

export interface ArtifactViewerProps {
  item: LibraryItem;
  agentName?: string | undefined;
  onClose: () => void;
}

/** Whether the browser can hand a file to the system share sheet. */
function canShareFiles(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function";
}

/**
 * The one full-screen viewer for every artifact type (pages, images, video, documents, plain files and Spaces). It fills
 * the viewport: a top bar (close, title, version menu, Share, Download) and the content. Until the content is on
 * screen the item's thumbnail sits underneath with a small spinner, so the area is never blank.
 */
export function ArtifactViewer(props: ArtifactViewerProps) {
  // A document is the same frame with the editor as its content; the editor (Tiptap) loads only when one is opened.
  if (props.item.render === "doc") {
    return (
      <Suspense fallback={<ViewerLoading />}>
        <DocumentViewer {...props} />
      </Suspense>
    );
  }
  return <FileViewer {...props} />;
}

function ViewerLoading() {
  return (
    <div role="status" aria-label="Loading" className="fixed inset-0 z-50 flex items-center justify-center bg-bg">
      <Loader2 aria-hidden="true" className="size-5 animate-spin text-fg-subtle" />
    </div>
  );
}

function FileViewer({ item, agentName, onClose }: ArtifactViewerProps) {
  const client = useClient();
  const kind = viewerKind(item);
  const versions = item.versions ?? [];
  const latest = latestVersion(item)?.version ?? item.version ?? 1;
  const [picked, setPicked] = useState<number | null>(null);
  const shown = picked !== null && versions.some((v) => v.version === picked) ? picked : latest;
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [sharePanel, setSharePanel] = useState(false);
  const space = useQuery({
    queryKey: ["space", item.spaceId],
    queryFn: () => client.spaces.get(item.spaceId as string),
    enabled: kind === "space" && Boolean(item.spaceId),
    refetchInterval: kind === "space" ? SPACE_POLL_MS : false,
    retry: false,
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function download(): Promise<void> {
    if (downloading) return;
    setDownloading(true);
    try {
      saveDownload(await loadItemFile(client, item, shown));
    } catch {
      toast("Download failed", { description: "Try again." });
    } finally {
      setDownloading(false);
    }
  }

  async function share(): Promise<void> {
    if (sharing) return;
    setSharing(true);
    try {
      const blob = fileBlob(await loadItemFile(client, item, shown));
      const file = new File([blob], safeBasename(item.name), { type: blob.type });
      if (!navigator.canShare({ files: [file] })) {
        toast("Sharing isn't available for this file", { description: "Download it instead." });
        return;
      }
      await navigator.share({ files: [file], title: item.name });
    } catch (error) {
      // Cancelling the system sheet is not a failure.
      if (!(error instanceof DOMException && error.name === "AbortError")) toast("Could not share", { description: "Try again." });
    } finally {
      setSharing(false);
    }
  }

  const sharesFile = kind !== "space" && canShareFiles();
  return (
    <section role="dialog" aria-modal="true" aria-label={item.name} data-slot="artifact-viewer" className="fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <IconButton label="Close" onClick={onClose} autoFocus>
          <X className="size-4" />
        </IconButton>
        <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold text-fg" title={item.name}>
          {item.name}
        </h2>
        {versions.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Choose version" className="gap-1">
                v{shown}
                {shown === latest && latest > 1 ? <span className="text-fg-subtle">· updated</span> : null}
                <ChevronDown className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              {[...versions].reverse().map((v) => (
                <DropdownMenuItem key={v.version} onSelect={() => setPicked(v.version)}>
                  v{v.version}
                  {v.version === latest ? " (latest)" : ""}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {kind === "space" ? (
          <Button variant="ghost" size="sm" disabled={!space.data} onClick={() => setSharePanel(true)}>
            <Share2 className="size-4" />
            Share
          </Button>
        ) : (
          <>
            {sharesFile ? (
              <IconButton label="Share" disabled={sharing} onClick={() => void share()}>
                <Share2 className="size-4" />
              </IconButton>
            ) : null}
            <IconButton label={downloading ? "Downloading…" : "Download"} disabled={downloading} onClick={() => void download()}>
              <Download className="size-4" />
            </IconButton>
          </>
        )}
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ViewerStage key={`${item.id}:${shown}`} item={item} version={shown} kind={kind} agentName={agentName} space={space.data} onOpened={() => void space.refetch()} />
      </div>
      {space.data ? <SpaceShareDialog space={space.data} name={item.name} open={sharePanel} onOpenChange={setSharePanel} /> : null}
    </section>
  );
}

/** One version's content with its loading cover. Keyed by version, so a new version starts loading again. */
function ViewerStage({
  item,
  version,
  kind,
  agentName,
  space,
  onOpened,
}: {
  item: LibraryItem;
  version: number;
  kind: ViewerKind;
  agentName: string | undefined;
  space: Space | undefined;
  onOpened: () => void;
}) {
  const [ready, setReady] = useState(false);
  const markReady = useCallback(() => setReady(true), []);
  const props: ViewerBodyProps = { item, version, agentName, onReady: markReady };
  return (
    <>
      {kind === "page" ? <PageBody {...props} /> : null}
      {kind === "image" ? <ImageBody {...props} /> : null}
      {kind === "video" ? <VideoBody {...props} /> : null}
      {kind === "document" ? <DocumentBody {...props} /> : null}
      {kind === "file" ? <FileBody {...props} /> : null}
      {kind === "space" ? <SpaceBody {...props} space={space} onOpened={onOpened} /> : null}
      {ready ? null : <LoadingCover item={item} />}
    </>
  );
}

/** The thumbnail under a spinner while the content loads. */
function LoadingCover({ item }: { item: LibraryItem }): ReactNode {
  return (
    <div role="status" aria-label="Loading" className={cn("absolute inset-0 z-[1] flex items-center justify-center bg-bg")}>
      <ArtifactThumb item={item} fit="contain" className="absolute inset-0 rounded-none bg-bg" />
      <span className="relative z-[1] flex size-9 items-center justify-center rounded-full bg-bg/85 shadow-sm">
        <Loader2 aria-hidden="true" className="size-4 animate-spin text-fg-subtle" />
      </span>
    </div>
  );
}
