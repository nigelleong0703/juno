import { ActionCardChip, ActionCardPreview, Textarea } from "@agent-desktop/ui";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { t } from "../../lib/i18n";

/** The draft a send approval shows, and the owner's edit of it: `edited` is the new body once it differs, else undefined. */
export function useDraftEditor(original: string | undefined) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(original ?? "");
  return { editing, text, setText, toggle: () => setEditing((value) => !value), edited: editing && text !== original ? text : undefined };
}

/** The draft (subject, body) in a preview frame; "Edit" turns the body into a text box until the card is answered. */
export function DraftPreview({ subject, editor, readOnly, className }: { subject?: string; editor: ReturnType<typeof useDraftEditor>; readOnly: boolean; className?: string }) {
  return (
    <ActionCardPreview
      className={className}
      chip={
        readOnly ? undefined : (
          <ActionCardChip label={t("request.editDraft")} onClick={editor.toggle}>
            <Pencil className="size-4" />
            {t("request.edit")}
          </ActionCardChip>
        )
      }
    >
      <div className="px-[18px] pb-14 pt-4 text-sm leading-5">
        {subject ? <div className="mb-1.5 font-semibold">{subject}</div> : null}
        {editor.editing ? (
          <Textarea value={editor.text} onChange={(event) => editor.setText(event.currentTarget.value)} aria-label={t("request.draft")} className="min-h-28 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0" />
        ) : (
          <p className="whitespace-pre-wrap">{editor.text}</p>
        )}
      </div>
    </ActionCardPreview>
  );
}
