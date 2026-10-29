import type { AgentHomeFile } from "@agent-desktop/client";
import { Button, Textarea, cn, toast } from "@agent-desktop/ui";
import { useEffect, useRef, useState } from "react";
import { errorCode } from "../../data/model-providers";
import { useWriteHomeFile } from "../../data/home";
import { t } from "../../lib/i18n";

/** Offset of the start of 1-based `line` in `text`, with the offset of its end. */
function lineRange(text: string, line: number): [number, number] {
  const lines = text.split("\n");
  const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
  return [start, start + (lines[line - 1]?.length ?? 0)];
}

/**
 * One memory file as editable text. Saving sends the hash the file was loaded with; when it changed
 * meanwhile (409) the file is reloaded, the stale edit dropped and the user told. `value`/`merge`
 * let a page edit only part of a file (the shared body of a people page).
 */
export function MemoryFileEditor({
  path,
  file,
  value,
  merge,
  focusLine,
  placeholder,
}: {
  path: string;
  file: AgentHomeFile | undefined;
  /** The editable part of the file; the whole content when absent. */
  value?: string;
  /** Rebuild the whole file from the edited part. */
  merge?: (edited: string) => string;
  focusLine?: number | undefined;
  placeholder?: string;
}) {
  const write = useWriteHomeFile();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const served = value ?? file?.content ?? "";
  const text = draft ?? served;
  const dirty = draft !== undefined && draft !== served;
  const area = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = area.current;
    if (el === null || focusLine === undefined) return;
    const [from, to] = lineRange(el.value, focusLine);
    el.focus();
    el.setSelectionRange(from, to);
    el.scrollTop = Math.max(0, (focusLine - 3) * 20);
  }, [focusLine, file?.hash]);

  const save = () => {
    if (draft === undefined) return;
    const content = merge === undefined ? draft : merge(draft);
    write.mutate(
      { path, content, ...(file === undefined ? {} : { expectedHash: file.hash }) },
      {
        onSuccess: () => {
          setDraft(undefined);
          setConflict(false);
          toast(t("memories.saved"));
        },
        onError: (error) => {
          if (errorCode(error).status === 409) {
            setDraft(undefined);
            setConflict(true);
          } else toast(t("common.error"));
        },
      },
    );
  };

  return (
    <div className="space-y-2">
      {conflict && (
        <p role="status" className="rounded-md bg-surface px-3 py-2 text-sm text-fg-muted">
          {t("memories.conflict")}
        </p>
      )}
      <Textarea
        ref={area}
        aria-label={path}
        className={cn("min-h-32 font-mono text-sm")}
        rows={Math.min(24, Math.max(6, text.split("\n").length + 1))}
        value={text}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <div className="flex items-center gap-1.5">
        <Button variant="primary" size="sm" disabled={!dirty || write.isPending} onClick={save}>
          {t("common.save")}
        </Button>
        {dirty && (
          <Button variant="ghost" size="sm" onClick={() => setDraft(undefined)}>
            {t("common.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Read-only file text; the line a search hit points at (1-based, counted from `firstLine`) is marked and scrolled into view. */
export function ReadOnlyText({ text, firstLine = 1, markLine }: { text: string; firstLine?: number; markLine?: number | undefined }) {
  return (
    <div className="max-h-96 overflow-y-auto whitespace-pre-wrap text-sm text-fg">
      {text.split("\n").map((line, i) => {
        const marked = markLine === firstLine + i;
        return (
          <div
            key={i}
            ref={marked ? (el) => el?.scrollIntoView?.({ block: "center" }) : undefined}
            className={marked ? "rounded bg-accent/60" : undefined}
          >
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}
