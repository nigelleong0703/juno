import type { Agent } from "@agent-desktop/client";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField, Textarea } from "@agent-desktop/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useClient } from "../../data/ClientProvider";
import { useHomeFiles } from "../../data/home";
import { errorCode } from "../../data/model-providers";
import { t } from "../../lib/i18n";

/** The agent's four identity files in its home, in form order (the iPhone's SoulEditSheet fields). */
const FIELDS = [
  { file: "IDENTITY.md", label: "agentIdentity.persona", note: "fileNote.identity", hint: "agentIdentity.personaHint" },
  { file: "SOUL.md", label: "agentIdentity.principles", note: "fileNote.soul" },
  { file: "AGENTS.md", label: "agentIdentity.instructions", note: "fileNote.agents", hint: "agentIdentity.instructionsHint" },
  { file: "TOOLS.md", label: "agentIdentity.toolNotes", note: "fileNote.tools" },
] as const;

/**
 * The identity files, loaded and saved through the home API. Each save carries the hash it was loaded with, so an edit
 * made elsewhere is never overwritten: on a conflict the file is reloaded and the user told. A failed save keeps the
 * edits on screen. Read-only (with a note) for anyone but the creator.
 */
function AgentIdentityForm({ agent, readOnly, onDone }: { agent: Agent; readOnly: boolean; onDone: () => void }) {
  const client = useClient();
  const qc = useQueryClient();
  const files = useHomeFiles(`agents/${agent.id}/`);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<string[]>([]);
  const path = (file: string) => `agents/${agent.id}/${file}`;
  const served = (file: string) => files.data?.find((f) => f.path === path(file))?.content ?? "";
  const changed = FIELDS.filter(({ file }) => texts[file] !== undefined && texts[file] !== served(file));

  const save = useMutation({
    mutationFn: async () => {
      const conflicted: string[] = [];
      for (const { file, label } of changed) {
        const hash = files.data?.find((f) => f.path === path(file))?.hash;
        try {
          await client.home.write(path(file), { content: texts[file] ?? "", ...(hash === undefined ? {} : { expectedHash: hash }) });
        } catch (error) {
          if (errorCode(error).status !== 409) throw error;
          conflicted.push(t(label));
        }
        // Saved, or conflicted and about to be reloaded: either way the stale edit goes.
        setTexts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== file)));
      }
      return conflicted;
    },
    onSuccess: (conflicted) => {
      setConflicts(conflicted);
      if (conflicted.length === 0) onDone();
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["home"] }),
  });

  const busy = save.isPending || files.isPending;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!readOnly && changed.length > 0 && !busy) {
          setConflicts([]);
          save.mutate();
        }
      }}
    >
      {FIELDS.map((field) => (
        <FormField key={field.file} label={t(field.label)} htmlFor={field.file} description={"hint" in field ? t(field.hint) : undefined} raw>
          <p className="border-l-2 border-border pl-3 text-xs italic text-fg-muted">{t(field.note, { name: agent.name })}</p>
          <Textarea
            id={field.file}
            rows={3}
            className="max-h-80 overflow-y-auto"
            value={texts[field.file] ?? served(field.file)}
            disabled={readOnly || busy}
            onChange={(event) => setTexts({ ...texts, [field.file]: event.target.value })}
          />
        </FormField>
      ))}
      {readOnly ? <p className="text-xs text-fg-muted">{t("agentIdentity.readOnly")}</p> : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-danger">
          {t("agentIdentity.failed")}
        </p>
      ) : null}
      {conflicts.length > 0 ? (
        <p role="alert" className="text-sm text-danger">
          {t("agentIdentity.conflict", { files: conflicts.join(", ") })}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={readOnly || busy || changed.length === 0}>
          {save.isPending ? t("agentEdit.saving") : t("common.save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function AgentIdentityDialog({ agent, open, onOpenChange, readOnly }: { agent: Agent; open: boolean; onOpenChange: (open: boolean) => void; readOnly: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("agentIdentity.title")}</DialogTitle>
          <DialogDescription>{t("agentIdentity.guidance")}</DialogDescription>
        </DialogHeader>
        <AgentIdentityForm agent={agent} readOnly={readOnly} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
