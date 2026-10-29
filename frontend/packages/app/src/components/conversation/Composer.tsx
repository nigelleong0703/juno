import type { Agent, Attachment, AvatarSpec, ComposerPayload } from "@agent-desktop/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  InputGroupAddon,
  PromptInput,
  PromptInputButton,
  PromptInputSubmit,
  PromptInputTextarea,
  TooltipProvider,
  cn,
} from "@agent-desktop/ui";
import { ArrowUp, CircleAlert, FileText, Loader2, Mic, Paperclip, Plus, Square, X } from "lucide-react";
import { useContext, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactElement } from "react";
import { ClientContext } from "../../data/ClientProvider";
import { t } from "../../lib/i18n";
import { useDictation, type DictationProblem } from "./useDictation";
import { compressImage } from "./compressImage";
import {
  insertMentionDraft,
  reconcileMentionDrafts,
  serializeMentionDraft,
  type MentionDraftSpan,
} from "../../lib/mention-draft";
import { findActiveMentionToken, matchCandidates } from "../../lib/mentions";
import type { MentionCandidate } from "../../lib/mentions";
import { AgentAvatar } from "../agent/AgentAvatar";
import type { ReplyTarget } from "./MessageMenu";

export interface ComposerProps {
  agents: MentionCandidate[];
  /** Tint the send button with the chat's agent accent (`--agent-accent` set by the thread). */
  accent?: boolean;
  /** Group chat: hint that a message needs an @mention to get a reply. */
  requireMention?: boolean;
  /** The agent that will answer (drives the placeholder). */
  primaryAgent?: Agent;
  running?: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend: (payload: ComposerPayload) => void;
  onStop?: () => void;
  /**
   * Keep the typed text, attachments and mention drafts after submit (the caller
   * clears by unmounting on success). The new-chat draft uses this so a failed
   * create keeps everything for retry. Defaults to clearing, as chats do.
   */
  clearOnSend?: boolean;
  className?: string;
  /** Typing activity (boolean only, never draft text) for an existing thread. */
  onActivity?: () => void;
  /** The draft went idle (blur/submit): end any active typing state. */
  onInactivity?: () => void;
  /** Text the field starts with (e.g. an accepted idea); read once on mount. */
  initialValue?: string;
  /**
   * Uploads a picked file (POST /v1/uploads) and returns the attachment a message carries. A message can only
   * reference uploaded files: the server refuses anything else. Without it the + menu cannot attach.
   */
  onUploadFile?: (file: File) => Promise<Attachment>;
  /** The message being replied to: a chip above the field names it until cancelled or sent. */
  reply?: ReplyTarget | null;
  onCancelReply?: () => void;
}

/** A picked file in the composer: uploading, ready (the server's attachment), or failed with a reason. */
interface DraftFile {
  localId: string;
  name: string;
  sizeBytes: number;
  /** The picked file, kept for a retry. */
  file: File;
  /** An object URL of the picked image, for the thumbnail. */
  previewUrl?: string;
  status: "uploading" | "ready" | "failed";
  attachment?: Attachment;
  error?: string;
}

/** The same per-file limit the server enforces (10 MiB); larger files are refused before uploading. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Owner reference 2026-10-05 (UF1): a compact single-row pill — `+` on the left, a
 * single-line field, then mic and send on the right — that grows with multiline
 * instead of the previous tall textarea + footer layout. Attachments, keyboard
 * send (Enter), placeholders and @-mentions are unchanged. The + add menu holds
 * only Attach file: teach/routine inserts were removed (GH1 #6) because they
 * advertised flows the composer does not perform.
 */

/** True while an IME composition is in flight (guarded without a type cast). */
function isComposingInput(native: unknown): boolean {
  if (typeof native !== "object" || native === null) return false;
  return "isComposing" in native && native.isComposing === true;
}

/** Selected picker row, anchored by ID so agent list updates keep the row stable. */
function selectedIndex(candidates: MentionCandidate[], selectedId: string | null): number {
  return Math.max(
    candidates.findIndex((candidate) => candidate.id === selectedId),
    0,
  );
}

/** One picker row: the member's avatar and display name, never the raw handle. */
function MentionPickerRow({
  candidate,
  avatar,
  title,
  showHandle,
  selected,
  onSelect,
}: {
  candidate: MentionCandidate;
  avatar: AvatarSpec | undefined;
  title: string | undefined;
  showHandle: boolean;
  selected: boolean;
  onSelect: () => void;
}): ReactElement {
  const display = candidate.name ?? "";
  const label = display === "" ? `@${candidate.handle}` : display;
  return (
    <div
      role="option"
      id={`composer-mention-${candidate.id}`}
      aria-selected={selected}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm",
        selected ? "bg-accent" : "text-fg-muted",
      )}
    >
      {avatar === undefined ? null : <AgentAvatar agentId={candidate.id} avatar={avatar} size={20} />}
      <span className="truncate font-medium">{label}</span>
      {title === undefined || title === "" ? null : (
        <span className="truncate text-fg-subtle">{title}</span>
      )}
      {showHandle ? <span className="truncate text-fg-subtle">@{candidate.handle}</span> : null}
    </div>
  );
}
export function Composer({
  agents,
  primaryAgent,
  accent,
  requireMention,
  running,
  disabled,
  placeholder,
  onSend,
  onStop,
  clearOnSend = true,
  className,
  onActivity,
  onInactivity,
  initialValue,
  onUploadFile,
  reply,
  onCancelReply,
}: ComposerProps) {
  const [value, setValue] = useState(initialValue ?? "");
  const [files, setFiles] = useState<DraftFile[]>([]);
  const attachments = files.flatMap((file) => (file.status === "ready" && file.attachment ? [file.attachment] : []));
  const uploading = files.some((file) => file.status === "uploading");
  const fileInput = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<{ anchor: number; query: string; selectedId: string | null } | null>(
    null,
  );
  const [draftSpans, setDraftSpans] = useState<MentionDraftSpan[]>([]);
  const [dictationProblem, setDictationProblem] = useState<DictationProblem | null>(null);
  // Optional: a composer rendered without a client has no dictation.
  const transcribe = useContext(ClientContext)?.client.transcribe;

  // Dictated text lands where typing would: after what is there, with a space between, caret at the end.
  const insertDictated = (spoken: string): void => {
    const joined = value === "" || /\s$/.test(value) ? value + spoken : `${value} ${spoken}`;
    setValue(joined);
    setPicker(null);
    requestAnimationFrame(() => {
      const field = getTextarea();
      if (field === null) return;
      field.focus();
      field.setSelectionRange(joined.length, joined.length);
    });
  };
  const dictation = useDictation({
    transcribe: transcribe === undefined ? undefined : (audio) => transcribe(audio),
    onText: insertDictated,
    onProblem: setDictationProblem,
  });

  // An attachment alone is a sendable message; text alone is too.
  const canSend = (value.trim().length > 0 || attachments.length > 0) && !uploading && !disabled;

  // Owner feedback (UF6): the Stop control renders only in an actually cancellable
  // state - a live run AND a stop handler (same convention as RunBlock). A Stop square
  // with no action behind it, or disabled by an empty box, is never shown: idle renders
  // the voice/send controls, never Stop.
  const canStop = running === true && onStop !== undefined;

  const getTextarea = (): HTMLTextAreaElement | null => boxRef.current?.querySelector("textarea") ?? null;

  const refreshPicker = (next: string, cursor: number): void => {
    const token = findActiveMentionToken(next.slice(0, cursor));
    const list = token === null ? [] : matchCandidates(token.query, agents);
    if (token === null || list.length === 0) {
      setPicker(null);
      return;
    }
    const firstId = list[0]?.id ?? null;
    setPicker((prev) => {
      if (prev !== null && prev.anchor === token.start && prev.query === token.query) {
        const kept = list.some((candidate) => candidate.id === prev.selectedId);
        return kept ? prev : { ...prev, selectedId: firstId };
      }
      return { anchor: token.start, query: token.query, selectedId: firstId };
    });
  };

  const insertCandidate = (candidate: MentionCandidate): void => {
    if (picker === null) return;
    // The live DOM caret goes stale (a deferred caret restore can land after
    // later edits), so the token end comes from the picker state the value
    // actually contains, never from selectionStart alone.
    const tokenEnd = Math.min(value.length, picker.anchor + 1 + picker.query.length);
    const end =
      value.slice(picker.anchor, tokenEnd) === `@${picker.query}`
        ? tokenEnd
        : Math.max(getTextarea()?.selectionStart ?? value.length, picker.anchor);
    const named = insertMentionDraft(value, picker.anchor, end, candidate);
    const next =
      named === null
        ? value.slice(0, picker.anchor) + `@${candidate.handle} ` + value.slice(end)
        : named.value;
    const kept = reconcileMentionDrafts(value, next, draftSpans);
    if (named !== null) kept.push(named.span);
    setValue(next);
    setDraftSpans(kept);
    setPicker(null);
    const caret = picker.anchor + (next.length - value.length + (end - picker.anchor));
    const placed = next;
    requestAnimationFrame(() => {
      const field = getTextarea();
      // Skip a stale restore: later edits already moved the caret elsewhere.
      if (field === null || field.value !== placed) return;
      field.focus();
      field.setSelectionRange(caret, caret);
    });
  };

  const onFieldChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.currentTarget.value;
    setValue(next);
    onActivity?.();
    setDraftSpans((prev) => reconcileMentionDrafts(value, next, prev));
    if (isComposingInput(event.nativeEvent)) {
      setPicker(null);
      return;
    }
    refreshPicker(next, event.currentTarget.selectionStart ?? next.length);
  };

  const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || picker === null) return;
    const list = matchCandidates(picker.query, agents);
    if (list.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const current = selectedIndex(list, picker.selectedId);
      const candidate = list[(current + step + list.length) % list.length];
      if (candidate === undefined) return;
      setPicker({ ...picker, selectedId: candidate.id });
      return;
    }
    if (event.key === "Enter") {
      const target = list[selectedIndex(list, picker.selectedId)];
      if (target === undefined) return;
      event.preventDefault();
      insertCandidate(target);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setPicker(null);
    }
  };

  const submit = (): void => {
    if (!canSend) return;
    onInactivity?.();
    const draft = serializeMentionDraft(value, draftSpans, agents);
    if (draft.mentions.length > 0) {
      onSend({ text: draft.text, attachments, mentions: draft.mentions });
    } else {
      onSend({ text: draft.text, attachments });
    }
    if (clearOnSend) {
      setValue("");
      setFiles([]);
      setDraftSpans([]);
      setPicker(null);
    }
  };

  const patchFile = (localId: string, patch: Partial<DraftFile>) =>
    setFiles((prev) => prev.map((entry) => (entry.localId === localId ? { ...entry, ...patch } : entry)));

  const startUpload = (entry: DraftFile) => {
    if (!onUploadFile) return;
    onUploadFile(entry.file).then(
      (attachment) => patchFile(entry.localId, { status: "ready", attachment }),
      () => patchFile(entry.localId, { status: "failed", error: t("composer.uploadFailed") }),
    );
  };

  const retryFile = (entry: DraftFile) => {
    patchFile(entry.localId, { status: "uploading" });
    startUpload(entry);
  };

  // A removed file is gone from the list, so a late upload result patches nothing.
  const removeFile = (entry: DraftFile) => {
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    setFiles((prev) => prev.filter((other) => other.localId !== entry.localId));
  };

  const addFiles = (picked: FileList | null) => {
    if (!picked || !onUploadFile) return;
    for (const original of Array.from(picked)) {
      void compressImage(original).then((file) => {
        const localId = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const tooLarge = file.size > MAX_UPLOAD_BYTES;
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        const entry: DraftFile = {
          localId, name: file.name, sizeBytes: file.size, file, status: tooLarge ? "failed" : "uploading",
          ...(previewUrl ? { previewUrl } : {}),
          ...(tooLarge ? { error: t("composer.fileTooLarge") } : {}),
        };
        setFiles((prev) => [...prev, entry]);
        if (!tooLarge) startUpload(entry);
      });
    }
  };

  const resolvedPlaceholder =
    placeholder ?? t("chat.placeholder", { name: primaryAgent?.name ?? t("chat.youAgent") });
  // Owner feedback (UI95): a textarea cannot ellipsise its placeholder, so a
  // narrow composer clipped "Message this c…" mid-word. The field shows a
  // compact "Message…" that always fits one line (reusing the existing mention
  // copy, no new locale); the full resolved text stays the accessible label.
  const visiblePlaceholder = `${t("mention.message")}…`;
  const matches = picker === null ? [] : matchCandidates(picker.query, agents);
  const activeIndex = picker === null ? 0 : selectedIndex(matches, picker.selectedId);
  const activeId = matches[activeIndex]?.id;
  const agentById = new Map(agents.map((agent) => [agent.id, agent] as const));
  /** A handle disambiguates only rows whose name and title both collide. */
  const needsHandle = (candidate: MentionCandidate): boolean => {
    const agent = agentById.get(candidate.id);
    const name = candidate.name ?? "";
    const title = agent?.title ?? "";
    return matches.some(
      (other) =>
        other.id !== candidate.id &&
        (other.name ?? "") === name &&
        (agentById.get(other.id)?.title ?? "") === title,
    );
  };

  return (
    <div ref={boxRef} className={cn("px-4 pb-3 pt-1", className)}>
      {/* Transition overlay (UI91 composer-transition): the clipped outer holds a plain
          fade and a shade that lay the surface gradient over the transcript. No blur. */}
      <div aria-hidden data-slot="composer-transition" className="composer-transition">
        <div aria-hidden className="composer-fade" />
        <div aria-hidden className="composer-shade" />
      </div>
      {picker !== null && matches.length > 0 && (
        <div
          id="composer-mention-picker"
          role="listbox"
          aria-label={t("composer.mentions")}
          className="absolute inset-x-0 bottom-full z-20 mb-2 px-4"
        >
          <div className="mx-auto max-h-64 w-full max-w-[760px] overflow-y-auto rounded-lg border border-border bg-bg-subtle shadow-overlay">
            {matches.map((candidate, index) => (
              <MentionPickerRow
                key={candidate.id}
                candidate={candidate}
                avatar={agentById.get(candidate.id)?.avatar}
                title={agentById.get(candidate.id)?.title}
                showHandle={needsHandle(candidate)}
                selected={index === activeIndex}
                onSelect={() => insertCandidate(candidate)}
              />
            ))}
          </div>
        </div>
      )}
      {requireMention && picker === null && canSend && draftSpans.length === 0 && !/(^|\s)@\S/.test(value) ? (
        <p data-slot="mention-hint" className="px-3 pb-1 text-xs text-fg-muted">{t("composer.mentionHint")}</p>
      ) : null}
      {dictationProblem !== null ? (
        <p role="alert" data-slot="dictation-problem" className="flex items-center gap-1.5 px-3 pb-1 text-xs text-danger">
          <CircleAlert className="size-3.5 shrink-0" />
          {t(`composer.dictation.${dictationProblem}`)}
        </p>
      ) : null}
      {/* ui's PromptInputButton renders a Radix tooltip without a provider of its own. */}
      <TooltipProvider>
        {reply ? (
          <div data-slot="reply-chip" className="relative z-10 mb-1.5 flex items-center gap-2 rounded-2xl border border-border bg-bg-subtle py-1.5 pl-3 pr-1">
            <span aria-hidden className="w-[3px] self-stretch rounded-full bg-fg-subtle" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-fg">{reply.name}</p>
              <p className="truncate text-xs text-fg-muted">{reply.text.split("\n")[0]}</p>
            </div>
            <button
              type="button"
              aria-label={t("message.cancelReply")}
              onClick={onCancelReply}
              className="grid size-7 shrink-0 place-items-center rounded-full text-fg-muted hover:bg-muted hover:text-fg focus-ring"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
        <PromptInput layout="inline" onSubmit={submit} className="composer-pill">
          {files.length > 0 && (
            <InputGroupAddon align="block-start" className="gap-2 overflow-x-auto pt-2">
              {files.map((attachment) => (
                <div key={attachment.localId} data-status={attachment.status} className="relative shrink-0 pr-1.5 pt-1.5">
                  <button
                    type="button"
                    title={attachment.name}
                    disabled={attachment.status !== "failed"}
                    onClick={() => retryFile(attachment)}
                    className="relative grid size-16 place-items-center overflow-hidden rounded-xl bg-muted text-fg-muted"
                  >
                    {attachment.previewUrl ? (
                      <img src={attachment.previewUrl} alt={attachment.name} className="size-full object-cover" />
                    ) : (
                      <span className="flex w-full flex-col items-center gap-1 px-1.5">
                        <FileText className="size-5" />
                        <span className="w-full truncate text-center text-xs">{attachment.name}</span>
                      </span>
                    )}
                    {attachment.status === "uploading" ? (
                      <span className="absolute inset-0 grid place-items-center bg-black/35 text-white">
                        <Loader2 className="size-5 animate-spin" />
                        <span className="sr-only">{t("composer.uploading")}</span>
                      </span>
                    ) : attachment.status === "failed" ? (
                      <span className="absolute inset-0 grid place-items-center bg-black/35 text-danger">
                        <CircleAlert className="size-6" />
                        <span className="sr-only">{attachment.error}</span>
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label={t("composer.removeAttachment")}
                    disabled={disabled}
                    className="absolute right-0 top-0 grid size-5 place-items-center rounded-full bg-black text-white ring-2 ring-bg"
                    onClick={() => removeFile(attachment)}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </InputGroupAddon>
          )}

          <InputGroupAddon align="inline-start">
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                addFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* Disabled with the field: no attachment can be picked until the
                    draft has somewhere to send it. */}
                <PromptInputButton
                  tooltip={t("composer.add")}
                  disabled={disabled}
                  className="size-8 rounded-full bg-bg-subtle"
                >
                  <Plus className="size-4" />
                </PromptInputButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>{t("composer.add")}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                  <Paperclip className="size-4" />
                  {t("composer.attach")}
               </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </InputGroupAddon>

          <PromptInputTextarea
            value={value}
            onChange={onFieldChange}
            onKeyDown={onFieldKeyDown}
            onBlur={() => onInactivity?.()}
            disabled={disabled}
            placeholder={visiblePlaceholder}
            aria-label={resolvedPlaceholder}
            aria-expanded={picker !== null}
            aria-controls="composer-mention-picker"
            aria-activedescendant={activeId === undefined ? undefined : `composer-mention-${activeId}`}
            rows={1}
            className="composer-field"
          />

          <InputGroupAddon align="inline-end">
            {canStop ? (
              <PromptInputSubmit status="streaming" disabled={false} onStop={onStop}>
                <Square className="size-3.5" />
              </PromptInputSubmit>
            ) : (
              <>
                {/* Dictation: tap to record, tap again to stop; the clip is transcribed by the backend. */}
                <PromptInputButton
                  tooltip={dictation.phase === "recording" ? t("composer.voiceStop") : t("composer.voice")}
                  aria-label={dictation.phase === "recording" ? t("composer.voiceStop") : t("composer.voice")}
                  disabled={disabled || transcribe === undefined || dictation.phase === "transcribing"}
                  onClick={dictation.toggle}
                  className={cn(
                    "size-8 rounded-full",
                    dictation.phase === "recording"
                      ? "bg-[var(--agent-accent,var(--primary))] text-[var(--agent-accent-fg,var(--primary-foreground))] hover:bg-[var(--agent-accent,var(--primary))]"
                      : "bg-bg-subtle text-fg-subtle",
                  )}
                >
                  {dictation.phase === "recording" ? (
                    <Square className="size-3.5 fill-current" />
                  ) : dictation.phase === "transcribing" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Mic className="size-4" />
                  )}
                </PromptInputButton>

                <PromptInputSubmit
                  status="ready"
                  disabled={!canSend}
                  className={accent && canSend ? "bg-[var(--agent-accent)] text-[var(--agent-accent-fg)] hover:bg-[var(--agent-accent)] hover:brightness-95" : undefined}
                >
                  <ArrowUp className="size-4" />
                </PromptInputSubmit>
              </>
            )}
          </InputGroupAddon>
        </PromptInput>
      </TooltipProvider>
    </div>
  );
}
