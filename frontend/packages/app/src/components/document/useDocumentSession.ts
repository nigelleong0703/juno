import type { DocumentDraft, DocumentView } from "@agent-desktop/client";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useClient } from "../../data/ClientProvider";
import { isOpenDraft, useDocument, useDocumentDraft, useDocumentVersion } from "../../data/documents";
import { qk } from "../../data/keys";

/** How long after the last keystroke the person's edits are saved as a draft. */
export const AUTOSAVE_MS = 1200;

export type SaveState = "idle" | "saving" | "saved" | "conflict" | "error";

/** What the editor shows and the Markdown it loaded; `key` rises whenever the baseline is replaced. */
export interface LoadedDocument {
  markdown: string;
  key: number;
}

function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Try again.";
}

/**
 * One open document: loads the Markdown to show (the open draft, else the saved head), autosaves the person's edits to
 * `PUT …/draft` with the revision it loaded, and decides the draft (`approve` is the person's save). A 409 never
 * overwrites anything: the local text stays and `saveState` becomes `conflict` until the person reloads.
 */
export function useDocumentSession(id: string) {
  const client = useClient();
  const qc = useQueryClient();
  const view = useDocument(id);
  const open = isOpenDraft(view.data?.draft) ? view.data?.draft : undefined;
  const headVersion = view.data?.document.version ?? 0;
  const draftContent = useDocumentDraft(id, Boolean(open));
  const headContent = useDocumentVersion(id, headVersion);

  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [busy, setBusy] = useState<"approving" | "declining" | null>(null);
  const [actionError, setActionError] = useState<string | undefined>();

  // What the server holds, as this session knows it. Refs because the autosave timer reads them after renders.
  const text = useRef("");
  const isDirty = useRef(false);
  const revision = useRef<number | null>(null);
  const draftId = useRef<string | null>(null);
  const baseVersion = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const conflict = useRef(false);
  const reloading = useRef(false);
  const generation = useRef(0);

  const adopt = useCallback((markdown: string, draft: DocumentDraft | undefined, head: number) => {
    clearTimeout(timer.current);
    text.current = markdown;
    isDirty.current = false;
    conflict.current = false;
    revision.current = draft?.revision ?? null;
    draftId.current = draft?.id ?? null;
    baseVersion.current = head;
    generation.current += 1;
    setDirty(false);
    setSaveState("idle");
    setLoaded({ markdown, key: generation.current });
  }, []);

  /** Fetch the document again and replace the editor's baseline with what the server has now. */
  const reload = useCallback(async () => {
    if (reloading.current) return;
    reloading.current = true;
    try {
      const next = await client.documents.get(id);
      qc.setQueryData<DocumentView>(qk.document(id), next);
      const head = next.document.version ?? 0;
      if (isOpenDraft(next.draft)) {
        const content = await client.documents.draft(id);
        qc.setQueryData(qk.documentDraft(id), content);
        adopt(content.markdown, content.draft, head);
      } else {
        const markdown = head >= 1 ? (await client.documents.version(id, head)).markdown : "";
        adopt(markdown, undefined, head);
      }
    } catch (error) {
      setActionError(messageOf(error));
    } finally {
      reloading.current = false;
    }
  }, [adopt, client, id, qc]);

  // First load: as soon as the Markdown to show has arrived.
  const ready = view.data !== undefined && (open ? draftContent.data !== undefined : headVersion < 1 || headContent.data !== undefined);
  useEffect(() => {
    if (loaded || !ready || !view.data) return;
    const markdown = open ? (draftContent.data?.markdown ?? "") : headVersion >= 1 ? (headContent.data?.markdown ?? "") : "";
    adopt(markdown, open, headVersion);
  }, [adopt, draftContent.data, headContent.data, headVersion, loaded, open, ready, view.data]);

  // The draft or the saved head moved without us (an agent replaced its draft, another device saved): follow it unless the person is mid-edit.
  useEffect(() => {
    if (!loaded || isDirty.current || inFlight.current || busy) return;
    const moved = (open?.id ?? null) !== draftId.current || (open?.revision ?? null) !== revision.current || headVersion !== baseVersion.current;
    if (moved) void reload();
  }, [busy, headVersion, loaded, open, reload]);

  const save = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) await inFlight.current;
    if (!isDirty.current) return !conflict.current;
    if (conflict.current) return false;
    const sent = text.current;
    const current = qc.getQueryData<DocumentView>(qk.document(id));
    const title = current?.draft?.title ?? current?.document.name ?? "Untitled";
    setSaveState("saving");
    const run = (async (): Promise<boolean> => {
      try {
        const saved = await client.documents.saveDraft(
          id,
          revision.current !== null ? { title, markdown: sent, expectedRevision: revision.current } : { title, markdown: sent, baseVersion: baseVersion.current },
        );
        revision.current = saved.draft.revision;
        draftId.current = saved.draft.id;
        qc.setQueryData<DocumentView>(qk.document(id), (old) => (old ? { ...old, draft: saved.draft } : old));
        qc.setQueryData(qk.documentDraft(id), saved);
        if (text.current === sent) {
          isDirty.current = false;
          setDirty(false);
          setSaveState("saved");
        } else {
          timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
        }
        return true;
      } catch (error) {
        conflict.current = statusOf(error) === 409;
        setSaveState(conflict.current ? "conflict" : "error");
        if (!conflict.current) setActionError(messageOf(error));
        return false;
      }
    })();
    inFlight.current = run;
    try {
      return await run;
    } finally {
      inFlight.current = null;
    }
  }, [client, id, qc]);

  const edit = useCallback(
    (markdown: string) => {
      text.current = markdown;
      isDirty.current = true;
      setDirty(true);
      setActionError(undefined);
      clearTimeout(timer.current);
      if (!conflict.current) timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
    },
    [save],
  );

  const approve = useCallback(async () => {
    setActionError(undefined);
    setBusy("approving");
    try {
      if (!(await save())) return;
      const current = qc.getQueryData<DocumentView>(qk.document(id))?.draft;
      if (!isOpenDraft(current)) return;
      const next = await client.documents.approve(id, { draftId: current.id, expectedRevision: revision.current ?? current.revision });
      revision.current = null;
      draftId.current = null;
      baseVersion.current = next.document.version ?? baseVersion.current;
      qc.setQueryData<DocumentView>(qk.document(id), next);
      void qc.invalidateQueries({ queryKey: ["document-version", id] });
      void qc.invalidateQueries({ queryKey: ["library"] });
      setSaveState("saved");
    } catch (error) {
      // 409: the draft changed under us (keep the text, offer a reload). 501 EXTERNAL_TARGET_UNAVAILABLE and the rest: say what the server said; the draft stays.
      if (statusOf(error) === 409) {
        conflict.current = true;
        setSaveState("conflict");
      } else {
        setActionError(messageOf(error));
      }
    } finally {
      setBusy(null);
    }
  }, [client, id, qc, save]);

  const decline = useCallback(async () => {
    setActionError(undefined);
    setBusy("declining");
    try {
      clearTimeout(timer.current);
      await inFlight.current;
      const current = qc.getQueryData<DocumentView>(qk.document(id))?.draft;
      if (!isOpenDraft(current)) return;
      await client.documents.decline(id, { draftId: current.id, expectedRevision: revision.current ?? current.revision });
      isDirty.current = false;
      await reload();
    } catch (error) {
      if (statusOf(error) === 409) {
        conflict.current = true;
        setSaveState("conflict");
      } else {
        setActionError(messageOf(error));
      }
    } finally {
      setBusy(null);
    }
  }, [client, id, qc, reload]);

  // Closing the viewer saves what is still waiting in the debounce.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (isDirty.current) void saveRef.current();
    },
    [],
  );

  return {
    view,
    loaded,
    draft: open,
    headVersion,
    /** The saved head's Markdown, for the changes view. */
    headMarkdown: headVersion >= 1 ? headContent.data?.markdown : "",
    dirty,
    saveState,
    busy,
    actionError,
    edit,
    reload,
    approve,
    decline,
    currentText: () => text.current,
  };
}
