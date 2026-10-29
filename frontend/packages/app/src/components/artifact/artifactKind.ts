import type { LibraryItem, SpaceStatus } from "@agent-desktop/client";

/** The Library's categories (owner-approved 2026-10-27): All · Pages · Files · Spaces · Shared. */
export type LibraryFilter = "all" | "pages" | "files" | "spaces" | "shared";
export const LIBRARY_FILTERS: readonly LibraryFilter[] = ["all", "pages", "files", "spaces", "shared"];

/** What the full-screen viewer shows for one item. */
export type ViewerKind = "page" | "image" | "video" | "document" | "file" | "space";

/** A running app: the chat card of a Space, or any item the server links to one. */
export function isSpaceItem(item: LibraryItem): boolean {
  return item.render === "app" || item.spaceId !== undefined;
}

/** The newest version (the one a thumbnail and a download show by default). */
export function latestVersion(item: LibraryItem) {
  return item.versions?.find((version) => version.version === item.version) ?? item.versions?.at(-1);
}

export function viewerKind(item: LibraryItem): ViewerKind {
  if (isSpaceItem(item)) return "space";
  if (item.render === "html") return "page";
  const type = item.mimeType ?? "";
  if (item.render === "image" || item.kind === "image" || type.startsWith("image/")) return "image";
  if (item.render === "video" || type.startsWith("video/")) return "video";
  if (item.render === "file") return "document";
  return "file";
}

/**
 * Where a grid cell's picture comes from, in order: the latest version's first-page thumbnail when the server made
 * one, the image itself for an image, and otherwise nothing (the cell shows the render type's icon on a muted surface).
 */
export type ThumbnailSource = "thumbnail" | "image" | "none";

export function thumbnailSource(item: LibraryItem): ThumbnailSource {
  if (latestVersion(item)?.thumbnailRef) return "thumbnail";
  if (viewerKind(item) === "image") return "image";
  return "none";
}

/** Whether an item belongs under a category. Spaces and pages are exclusive of files; Shared is a hosted link. */
export function matchesLibraryFilter(item: LibraryItem, filter: LibraryFilter, hostedSpaceIds: ReadonlySet<string>): boolean {
  switch (filter) {
    case "all":
      return true;
    case "pages":
      return item.render === "html";
    case "files":
      return item.render !== "html" && !isSpaceItem(item);
    case "spaces":
      return isSpaceItem(item);
    case "shared":
      return item.spaceId !== undefined && hostedSpaceIds.has(item.spaceId);
  }
}

export interface LibraryQuery {
  filter: LibraryFilter;
  query: string;
  agentId: string;
  hostedSpaceIds: ReadonlySet<string>;
}

/** The Library's list: the category, the agent scope and the search text (name or tag), newest order kept as given. */
export function filterLibrary(items: readonly LibraryItem[], { filter, query, agentId, hostedSpaceIds }: LibraryQuery): LibraryItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (agentId === "all" || item.createdByAgentId === agentId) &&
      matchesLibraryFilter(item, filter, hostedSpaceIds) &&
      (!needle || item.name.toLowerCase().includes(needle) || item.tags.some((tag) => tag.toLowerCase().includes(needle))),
  );
}

/** The muted status word under a Space's cell: running or paused (other states name themselves). */
export function spaceStatusLabel(status: SpaceStatus | undefined): string | undefined {
  switch (status) {
    case "running":
      return "Running";
    case "computer_paused":
      return "Paused";
    case "not_listening":
      return "Not listening";
    default:
      return undefined;
  }
}
