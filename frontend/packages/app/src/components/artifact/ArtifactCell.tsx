import type { LibraryItem, SpaceStatus } from "@agent-desktop/client";
import { cn } from "@agent-desktop/ui";
import { useDocument } from "../../data/documents";
import { formatAgo } from "../../lib/format";
import { t } from "../../lib/i18n";
import { ArtifactThumb } from "./ArtifactThumb";
import { isSpaceItem, spaceStatusLabel } from "./artifactKind";

export interface ArtifactCellProps {
  item: LibraryItem;
  agentName?: string | undefined;
  /** A Space's status (from the Spaces list); shown as a muted word on its second line. */
  spaceStatus?: SpaceStatus | undefined;
  onOpen: () => void;
  className?: string;
}

/**
 * One item as a grid cell: its picture (4:3, a small corner radius), the name on one line, and a muted line
 * "<agent> · <relative time>" (a Space: "<agent> · <status> · <time>"). No border or filled card around it.
 */
export function ArtifactCell({ item, agentName, spaceStatus, onOpen, className }: ArtifactCellProps) {
  const author = agentName ?? (item.source === "upload" ? t("library.you") : undefined);
  const status = isSpaceItem(item) ? spaceStatusLabel(spaceStatus) : undefined;
  // A document an agent proposed and nobody has decided yet says so under its name.
  const document = useDocument(item.id, item.render === "doc");
  const reviewing = typeof document.data?.draft?.author === "object" && document.data.draft.status === "pending";
  const meta = reviewing ? "Draft · waiting for your review" : [author, status, formatAgo(item.updatedAt)].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      data-slot="artifact-cell"
      aria-label={item.name}
      onClick={onOpen}
      className={cn("group flex min-w-0 flex-col gap-2 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-focus-ring", className)}
    >
      <ArtifactThumb item={item} className="aspect-[4/3] w-full rounded-lg transition-opacity duration-150 group-hover:opacity-90" />
      <span className="min-w-0 px-0.5">
        <span className="block truncate text-sm font-medium leading-5 text-fg">{item.name}</span>
        <span className="block truncate text-xs leading-[18px] text-fg-subtle">{meta}</span>
      </span>
    </button>
  );
}
