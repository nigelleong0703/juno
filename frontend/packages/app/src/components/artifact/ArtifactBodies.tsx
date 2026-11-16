import type { LibraryItem, Space } from "@agent-desktop/client";
import { Button, IconButton, Markdown, RelativeTime, cn } from "@agent-desktop/ui";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useClient, usePlatform } from "../../data/ClientProvider";
import { formatBytes } from "../../lib/format";
import { decodeBase64, fileFormat } from "../conversation/artifactPreview";
import { FileContentPreview } from "../chat-files/FileContentPreview";
import { PdfFilePreview } from "../chat-files/PdfFilePreview";
import { fileBlob, loadItemFile, useObjectUrl } from "./artifactBytes";
import { ArtifactThumb } from "./ArtifactThumb";
import { latestVersion, spaceStatusLabel } from "./artifactKind";

/** A centred line for a body that cannot show its content. */
function Message({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-fg-subtle">{children}</div>;
}

/** The bodies share one contract: each fills its box (`absolute inset-0`) and calls `onReady` once its content is on screen. */
export interface ViewerBodyProps {
  item: LibraryItem;
  /** The version on screen (published items); unused for plain files. */
  version: number;
  agentName?: string | undefined;
  onReady: () => void;
}

const RENDER_URL_MARGIN_MS = 60_000;

/** The signed render address of an HTML version; re-requested when the cached one is (nearly) expired. */
function useRenderUrl(id: string, version: number) {
  const client = useClient();
  const query = useQuery({
    queryKey: ["artifact-render-url", id, version],
    queryFn: () => client.artifacts.renderUrl(id, version),
    retry: false,
    staleTime: Infinity,
  });
  const expiresAt = query.data ? Date.parse(query.data.expiresAt) : 0;
  const fresh = Boolean(query.data) && expiresAt - Date.now() > RENDER_URL_MARGIN_MS;
  const { refetch, isFetching } = query;
  useEffect(() => {
    if (query.data && !fresh && !isFetching) void refetch();
  }, [query.data, fresh, isFetching, refetch]);
  return { url: fresh ? query.data?.url : undefined, isError: query.isError, retry: () => void refetch() };
}

/** An interactive page: the sandboxed frame, script-only, full size. Never allow-same-origin, popups, forms or top navigation. */
export function PageBody({ item, version, onReady }: ViewerBodyProps) {
  const page = useRenderUrl(item.id, version);
  if (page.isError) {
    return (
      <Message>
        <span>Couldn't load this page.</span>
        <Button variant="ghost" size="sm" onClick={page.retry}>Retry</Button>
      </Message>
    );
  }
  if (!page.url) return null;
  return (
    <iframe
      title={item.name}
      src={page.url}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={onReady}
      className="absolute inset-0 size-full border-0 bg-white"
    />
  );
}

/** A picture, zoomable: fit to the screen, then 1.5x steps up to 4x; double-click toggles fit and 2x. */
export function ImageBody({ item, version, onReady }: ViewerBodyProps) {
  const client = useClient();
  const file = useQuery({
    queryKey: ["artifact-file", item.id, version, "image"],
    queryFn: async () => fileBlob(await loadItemFile(client, item, version)),
    retry: false,
    staleTime: Infinity,
  });
  const url = useObjectUrl(file.data);
  const [zoom, setZoom] = useState(1);
  if (file.isError) return <Message>Image unavailable.</Message>;
  if (!url) return null;
  const fit = zoom === 1;
  return (
    <div className="absolute inset-0 flex flex-col">
      <div className={cn("min-h-0 flex-1 overflow-auto bg-muted/50", fit ? "flex items-center justify-center p-4" : "p-4")}>
        <img
          src={url}
          alt={item.name}
          draggable={false}
          onLoad={onReady}
          onDoubleClick={() => setZoom((current) => (current === 1 ? 2 : 1))}
          style={fit ? undefined : { width: `${zoom * 100}%`, maxWidth: "none" }}
          className={cn("select-none", fit ? "max-h-full max-w-full object-contain" : "block h-auto")}
        />
      </div>
      <div className="flex shrink-0 items-center justify-center gap-2 border-t border-border p-2">
        <IconButton label="Zoom out" disabled={fit} onClick={() => setZoom((current) => Math.max(1, current / 1.5))}>
          <ZoomOut className="size-4" />
        </IconButton>
        <span className="w-12 text-center text-xs tabular-nums text-fg-muted">{Math.round(zoom * 100)}%</span>
        <IconButton label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom((current) => Math.min(4, current * 1.5))}>
          <ZoomIn className="size-4" />
        </IconButton>
      </div>
    </div>
  );
}

/** A video, with its own controls. */
export function VideoBody({ item, version, onReady }: ViewerBodyProps) {
  const client = useClient();
  const file = useQuery({
    queryKey: ["artifact-file", item.id, version, "video"],
    queryFn: async () => fileBlob(await loadItemFile(client, item, version)),
    retry: false,
    staleTime: Infinity,
  });
  const url = useObjectUrl(file.data);
  if (file.isError) return <Message>Video unavailable.</Message>;
  if (!url) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black">
      <video controls playsInline preload="metadata" src={url} onLoadedData={onReady} className="max-h-full max-w-full" />
    </div>
  );
}

/** A document: Markdown as text, a PDF or an Office file's preview as pages, anything else as its contents and facts. */
export function DocumentBody({ item, version, agentName, onReady }: ViewerBodyProps) {
  const current = item.versions?.find((v) => v.version === version) ?? latestVersion(item);
  const isMarkdown = current?.mimeType === "text/markdown" || item.name.toLowerCase().endsWith(".md");
  const previewPart = current?.mimeType === "application/pdf" ? "file" : current?.previewRef ? "preview" : undefined;
  if (isMarkdown) return <MarkdownBody item={item} version={version} onReady={onReady} />;
  if (previewPart) return <PagesBody item={item} version={version} part={previewPart} onReady={onReady} />;
  return <FileBody item={item} version={version} agentName={agentName} onReady={onReady} />;
}

function MarkdownBody({ item, version, onReady }: ViewerBodyProps) {
  const client = useClient();
  const text = useQuery({
    queryKey: ["artifact-text", item.id, version],
    queryFn: async () => new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64((await loadItemFile(client, item, version)).contentBase64)),
    retry: false,
    staleTime: Infinity,
  });
  const settled = text.data !== undefined || text.isError;
  useEffect(() => {
    if (settled) onReady();
  }, [settled, onReady]);
  if (text.isError) return <Message>Preview unavailable. Download the file to read it.</Message>;
  if (text.data === undefined) return null;
  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] px-5 py-6">
        <Markdown allowMedia={false} className="break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto">{text.data}</Markdown>
      </div>
    </div>
  );
}

function PagesBody({ item, version, part, onReady }: ViewerBodyProps & { part: "file" | "preview" }) {
  const client = useClient();
  const pages = useQuery({
    queryKey: ["artifact-file", item.id, version, part],
    queryFn: async () => fileBlob(await client.artifacts.download(item.id, version, part)),
    retry: false,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (pages.data || pages.isError) onReady();
  }, [pages.data, pages.isError, onReady]);
  if (pages.isError) return <Message>Preview unavailable. Download the file to view it.</Message>;
  if (!pages.data) return null;
  return (
    <div className="absolute inset-0 overflow-y-auto bg-muted/40 p-4">
      <PdfFilePreview blob={pages.data} />
    </div>
  );
}

/** A plain file: its contents where the app can show them, then the facts about it. Download and Share are in the top bar. */
export function FileBody({ item, agentName, onReady }: ViewerBodyProps) {
  useEffect(() => {
    onReady();
  }, [onReady]);
  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-5 py-6">
        <FileContentPreview item={item} />
        <FileFacts item={item} agentName={agentName} />
      </div>
    </div>
  );
}

/** The facts line by line: kind, size, author, last change and who can see it. */
export function FileFacts({ item, agentName }: { item: LibraryItem; agentName?: string | undefined }) {
  const facts: [string, ReactNode][] = [
    ["Kind", fileFormat(item.name)],
    ["Size", formatBytes(item.sizeBytes)],
    ["Created by", item.source === "agent" ? (agentName ?? "An agent") : "You"],
    ["Updated", <RelativeTime key="updated" date={item.updatedAt} />],
    ["Shared", item.shared === "team" ? "Team" : "Private"],
  ];
  return (
    <dl className="space-y-2">
      {facts.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4 text-sm">
          <dt className="text-fg-muted">{label}</dt>
          <dd className="min-w-0 truncate text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A running app: its status and one button that opens it in the browser. The app itself is never embedded. */
export function SpaceBody({ item, space, agentName, onOpened, onReady }: ViewerBodyProps & { space: Space | undefined; onOpened: () => void }) {
  const client = useClient();
  const platform = usePlatform();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    onReady();
  }, [onReady]);
  const status = spaceStatusLabel(space?.status);
  const paused = space?.status === "computer_paused";
  const running = space?.status === "running";
  const spaceId = item.spaceId;

  async function open(): Promise<void> {
    if (!spaceId || opening) return;
    setOpening(true);
    setError(null);
    try {
      // A fresh link per tap: it lives five minutes and carries the sign-in, so it is never kept.
      const { url } = await client.spaces.openUrl(spaceId);
      platform.openExternal(url);
      onOpened();
    } catch {
      setError("Could not open the app. Try again.");
    } finally {
      setOpening(false);
    }
  }

  // The app's page: its picture on the left, who made it, when, whether it is running and Open on the right (owner design 2026-11-06).
  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10 md:flex-row md:items-center md:py-16">
        <div className="aspect-[4/3] w-full shrink-0 overflow-hidden rounded-2xl border border-border bg-bg-subtle md:w-[440px]">
          <ArtifactThumb item={item} className="size-full" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
          <h1 className="break-words text-2xl font-semibold text-fg">{item.name}</h1>
          <p className="text-sm text-fg-muted">
            {agentName ? <>Made by {agentName} · </> : null}
            <RelativeTime date={item.updatedAt} />
          </p>
          {status ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-bg-subtle px-2.5 py-1 text-xs font-medium text-fg">
              <span aria-hidden className={cn("size-1.5 rounded-full", running ? "bg-success" : paused ? "bg-warning" : "bg-fg-subtle")} />
              {status}
            </span>
          ) : null}
          <Button size="lg" variant={paused ? "secondary" : "default"} disabled={!spaceId || opening} onClick={() => void open()} className="mt-3">
            <ExternalLink className="size-4" />
            {opening ? "Opening…" : paused ? "Wake & open" : "Open"}
          </Button>
          <p className="text-xs text-fg-subtle">Opens in your browser.</p>
          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
