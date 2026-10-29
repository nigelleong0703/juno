import { diffBlocks } from "@agent-desktop/doc-editor";
import { cn } from "@agent-desktop/ui";
import { useMemo } from "react";

/**
 * What the draft changes against the saved version, block by block: new blocks tinted, removed blocks struck through and
 * muted, unchanged blocks as context. Blocks are the parts between blank lines, shown as written (Markdown source).
 */
export function ChangesView({ saved, draft }: { saved: string; draft: string }) {
  const blocks = useMemo(() => diffBlocks(saved, draft), [saved, draft]);
  if (!blocks.some((block) => block.kind !== "same")) return <p className="text-sm text-fg-subtle">No changes against the saved version.</p>;
  return (
    <ol aria-label="Changes" className="flex flex-col gap-2">
      {blocks.map((block, index) => (
        <li
          key={index}
          data-change={block.kind}
          className={cn(
            "whitespace-pre-wrap rounded-md px-3 py-2 font-mono text-[13px] leading-6",
            block.kind === "added" && "bg-success-subtle text-fg",
            block.kind === "removed" && "text-fg-subtle line-through",
            block.kind === "same" && "text-fg-muted",
          )}
        >
          <span className="sr-only">{block.kind === "added" ? "Added: " : block.kind === "removed" ? "Removed: " : ""}</span>
          {block.text}
        </li>
      ))}
    </ol>
  );
}
