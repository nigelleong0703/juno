import type { ReactNode } from "react";
import { FileIcon } from "./FileIcon";
import { cn } from "@/lib/utils";

export interface FilePreviewProps {
  name: string;
  size?: string;
  meta?: ReactNode;
  thumbnail?: ReactNode;
  onRemove?: () => void;
  className?: string;
}

/** Compact file card: thumbnail or glyph, name, size and optional meta. */
export function FilePreview({
  name,
  size,
  meta,
  thumbnail,
  onRemove,
  className,
}: FilePreviewProps) {
  return (
    <div
      data-slot="file-preview"
      className={cn(
        "flex items-center gap-3 rounded-lg border border-border bg-card p-2 pr-3",
        className,
      )}
    >
      <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
        {thumbnail ?? <FileIcon name={name} size={18} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{name}</div>
        {(size || meta) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {size && <span>{size}</span>}
            {meta}
          </div>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        >
          <span aria-hidden className="text-lg leading-none">×</span>
        </button>
      )}
    </div>
  );
}
