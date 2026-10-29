import type { LibraryItem } from "@agent-desktop/client";
import { DocumentEditor, type DocumentEditorHandle, type EditorCommand, type EditorMode, type EditorState, type SourceInputProps } from "@agent-desktop/doc-editor";
import "@agent-desktop/doc-editor/editor.css";
import { Button, ErrorState, FormField, IconButton, SegmentedControl, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, Textarea } from "@agent-desktop/ui";
import { Loader2, MessageSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useApps } from "../../data/apps";
import { useDocumentConversation } from "../../data/documents";
import { ConversationContainer } from "../../features/conversation/ConversationContainer";
import { ChangesView } from "./ChangesView";
import { DocumentToolbar } from "./DocumentToolbar";
import { useDocumentSession, type SaveState } from "./useDocumentSession";

export interface DocumentViewerProps {
  item: LibraryItem;
  agentName?: string | undefined;
  onClose: () => void;
}

/** The catalog `Textarea` as the editor's source mode. */
function SourceTextarea({ className: _ignored, ...props }: SourceInputProps) {
  return <Textarea spellCheck={false} className="min-h-[60vh] border-0 bg-transparent px-0 font-mono text-sm shadow-none focus-visible:ring-0" {...props} />;
}

function statusWord(state: SaveState, dirty: boolean): string {
  if (state === "saving") return "Saving…";
  if (state === "error") return "Not saved";
  if (state === "saved" && !dirty) return "Saved";
  return dirty ? "Unsaved changes" : "";
}

/**
 * The full-screen viewer of a document (`render: doc`): the editor in the content area. An agent's draft opens for review
 * (Approve & save / Decline, with a Changes view against the saved version); the person's own edits autosave as a draft
 * and Save makes them the next version. Same frame as `ArtifactViewer`: top bar, then content.
 */
export function DocumentViewer({ item, agentName, onClose }: DocumentViewerProps) {
  const session = useDocumentSession(item.id);
  const { view, loaded, draft } = session;
  const handle = useRef<DocumentEditorHandle>(null);
  const [mode, setMode] = useState<EditorMode>("rich");
  const [format, setFormat] = useState<EditorState>({});
  const [segment, setSegment] = useState<"draft" | "changes">("draft");
  const [talking, setTalking] = useState(false);
  const apps = useApps();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !talking) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, talking]);

  if (view.isError) {
    return (
      <section role="dialog" aria-modal="true" aria-label={item.name} data-slot="artifact-viewer" className="fixed inset-0 z-50 flex flex-col bg-bg">
        <ErrorState title="This document is no longer here" description="It may have been deleted." action={<Button variant="ghost" size="sm" onClick={onClose}>Close</Button>} />
      </section>
    );
  }

  const document = view.data?.document ?? item;
  const authorAgentId = draft && typeof draft.author === "object" ? draft.author.agentId : undefined;
  const chatAgentId = document.createdByAgentId ?? authorAgentId;
  const byAgent = authorAgentId !== undefined && !session.dirty;
  const target = document.target;
  const targetApp = target ? (apps.data?.find((app) => app.id === target.appId)?.name ?? target.appId) : undefined;
  const reviewing = Boolean(draft) && byAgent;
  const canCompare = Boolean(draft) && session.headVersion >= 1 && session.headMarkdown !== undefined;
  const showChanges = canCompare && segment === "changes";
  const conflict = session.saveState === "conflict";
  const status = statusWord(session.saveState, session.dirty);
  const hasChanges = session.dirty || Boolean(draft);

  return (
    <section role="dialog" aria-modal="true" aria-label={document.name} data-slot="artifact-viewer" className="fixed inset-0 z-50 flex flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <IconButton label="Close" onClick={onClose} autoFocus>
          <X className="size-4" />
        </IconButton>
        <h2 className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold text-fg" title={document.name}>
          {document.name}
        </h2>
        {status ? <span role="status" className="hidden shrink-0 text-xs text-fg-subtle sm:inline">{status}</span> : null}
        {chatAgentId ? (
          <Button variant="ghost" size="sm" onClick={() => setTalking(true)} aria-label="Talk about this document">
            <MessageSquare className="size-4" />
            <span className="hidden md:inline">Talk about this document</span>
          </Button>
        ) : null}
        {conflict ? (
          <Button variant="secondary" size="sm" onClick={() => void session.reload()}>
            Reload
          </Button>
        ) : hasChanges ? (
          <>
            {draft ? (
              <Button variant="ghost" size="sm" disabled={session.busy !== null} onClick={() => void session.decline()}>
                {session.busy === "declining" ? <Loader2 className="size-4 animate-spin" /> : null}
                {reviewing ? "Decline" : "Discard"}
              </Button>
            ) : null}
            <Button size="sm" disabled={session.busy !== null || !loaded} onClick={() => void session.approve()}>
              {session.busy === "approving" ? <Loader2 className="size-4 animate-spin" /> : null}
              {reviewing ? "Approve & save" : "Save"}
            </Button>
          </>
        ) : null}
      </header>

      {reviewing || target || session.actionError ? (
        <div className="shrink-0 space-y-0.5 px-4 pt-3 text-xs text-fg-subtle">
          {reviewing ? (
            <p>
              {agentName ?? "An agent"} proposed changes{draft?.summary ? ` · ${draft.summary}` : ""}
            </p>
          ) : null}
          {target ? (
            <p>
              Will be written to{" "}
              <a href={target.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                {targetApp}
              </a>{" "}
              after approval
            </p>
          ) : null}
          {session.actionError ? (
            <p role="alert" className="text-danger">
              {session.actionError}
            </p>
          ) : null}
        </div>
      ) : null}

      {canCompare ? (
        <div className="shrink-0 px-4 pt-3">
          <SegmentedControl
            aria-label="Document view"
            value={segment}
            onValueChange={(next) => setSegment(next === "changes" ? "changes" : "draft")}
            items={[
              { value: "draft", label: "Draft" },
              { value: "changes", label: "Changes" },
            ]}
          />
        </div>
      ) : null}

      {mode === "rich" && loaded && !showChanges ? <DocumentToolbar state={format} disabled={conflict} onCommand={(command: EditorCommand, argument?: string) => handle.current?.run(command, argument)} /> : null}

      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <div role="status" aria-label="Loading" className="flex h-full items-center justify-center">
            <Loader2 aria-hidden="true" className="size-5 animate-spin text-fg-subtle" />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-6">
            {showChanges ? <ChangesView saved={session.headMarkdown ?? ""} draft={session.currentText()} /> : null}
            <div hidden={showChanges}>
              <FormField label="Document" raw error={conflict ? "Changed elsewhere — reload" : undefined} className="[&>label]:sr-only">
                <DocumentEditor
                  markdown={loaded.markdown}
                  resetKey={loaded.key}
                  editable={!conflict && session.busy === null}
                  onChange={session.edit}
                  handleRef={handle}
                  onModeChange={setMode}
                  onStateChange={setFormat}
                  SourceInput={SourceTextarea}
                />
              </FormField>
            </div>
          </div>
        )}
      </div>

      {chatAgentId ? <TalkSheet documentId={item.id} agentId={chatAgentId} name={document.name} open={talking} onOpenChange={setTalking} /> : null}
    </section>
  );
}

/** The conversation about this document with its agent, in a side sheet (opened on demand; the same chat every time). */
function TalkSheet({ documentId, agentId, name, open, onOpenChange }: { documentId: string; agentId: string; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const opener = useDocumentConversation(documentId);
  const { mutate, data, reset } = opener;
  useEffect(() => {
    if (open && !data && !opener.isPending && !opener.isError) mutate(agentId);
    if (!open) reset();
  }, [agentId, data, mutate, open, opener.isError, opener.isPending, reset]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="shrink-0 border-b border-border">
          <SheetTitle className="truncate">{name}</SheetTitle>
          <SheetDescription className="sr-only">Chat about this document</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1">
          {data ? (
            <ConversationContainer conversationId={data.id} className="h-full" />
          ) : opener.isError ? (
            <ErrorState title="Couldn't open the chat" description={opener.error.message} onRetry={() => mutate(agentId)} />
          ) : (
            <div role="status" aria-label="Loading" className="flex h-full items-center justify-center">
              <Loader2 aria-hidden="true" className="size-5 animate-spin text-fg-subtle" />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
