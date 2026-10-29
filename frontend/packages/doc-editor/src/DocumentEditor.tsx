import { useEditor, EditorContent } from "@tiptap/react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ChangeEvent, type ComponentType, type Ref } from "react";
import { editorState, runCommand, type EditorCommand, type EditorState } from "./commands";
import { documentExtensions } from "./extensions";
import { survivesRoundTrip } from "./roundTrip";

/** `rich` is the formatted editor; `source` is plain Markdown, used when the rich editor would lose content. */
export type EditorMode = "rich" | "source";

export interface DocumentEditorHandle {
  mode: EditorMode;
  run(command: EditorCommand, argument?: string): void;
}

/** The plain-text field of source mode. The web app passes its catalog `Textarea`; the bundled iOS page uses the default. */
export interface SourceInputProps {
  value: string;
  disabled: boolean;
  onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  "aria-label": string;
  className?: string;
}

export interface DocumentEditorProps {
  /** The Markdown that was loaded. A new value (with a new `resetKey`) replaces the content; typing never changes it. */
  markdown: string;
  /** Change it to load `markdown` again (another version, a reload after a conflict). */
  resetKey: string | number;
  editable?: boolean;
  /** Called with the full Markdown after every edit. */
  onChange: (markdown: string) => void;
  handleRef?: Ref<DocumentEditorHandle>;
  onModeChange?: (mode: EditorMode) => void;
  onStateChange?: (state: EditorState) => void;
  SourceInput?: ComponentType<SourceInputProps>;
  className?: string;
}

function PlainSourceInput(props: SourceInputProps) {
  return <textarea spellCheck={false} {...props} className={props.className ?? "doc-editor-source"} />;
}

/**
 * The document editor shared by the web app and the page bundled in the iOS app. It opens the rich editor when the
 * Markdown survives the editor's round trip and plain Markdown otherwise, so saving never drops content.
 */
export function DocumentEditor({ markdown, resetKey, editable = true, onChange, handleRef, onModeChange, onStateChange, SourceInput = PlainSourceInput, className }: DocumentEditorProps) {
  const rich = useMemo(() => survivesRoundTrip(markdown), [markdown]);
  const mode: EditorMode = rich ? "rich" : "source";
  useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);
  return rich ? (
    <RichEditor key={resetKey} markdown={markdown} editable={editable} onChange={onChange} handleRef={handleRef} onStateChange={onStateChange} className={className} />
  ) : (
    <SourceEditor key={resetKey} markdown={markdown} editable={editable} onChange={onChange} handleRef={handleRef} SourceInput={SourceInput} className={className} />
  );
}

type InnerProps = Pick<DocumentEditorProps, "markdown" | "editable" | "onChange" | "handleRef" | "className">;

function RichEditor({ markdown, editable = true, onChange, handleRef, onStateChange, className }: InnerProps & Pick<DocumentEditorProps, "onStateChange">) {
  // What the editor wrote for the loaded text. Loading can itself raise an update; only a different text is an edit.
  const written = useRef<string | null>(null);
  const editor = useEditor({
    extensions: documentExtensions(),
    content: markdown,
    contentType: "markdown",
    editable,
    onCreate: ({ editor: e }) => {
      written.current ??= e.getMarkdown();
    },
    onUpdate: ({ editor: e }) => {
      const next = e.getMarkdown();
      // The update that loading raises can arrive before `onCreate`: it is the baseline, not an edit.
      if (written.current === null || next === written.current) {
        written.current ??= next;
        return;
      }
      written.current = next;
      onChange(next);
    },
    onTransaction: ({ editor: e }) => onStateChange?.(editorState(e)),
    editorProps: { attributes: { class: "doc-editor-content", "aria-label": "Document" } },
  });
  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);
  useImperativeHandle(handleRef, () => ({ mode: "rich" as const, run: (command, argument) => runCommand(editor, command, argument) }), [editor]);
  return <EditorContent editor={editor} className={className} data-slot="doc-editor" />;
}

function SourceEditor({ markdown, editable = true, onChange, handleRef, SourceInput, className }: InnerProps & { SourceInput: ComponentType<SourceInputProps> }) {
  // The field is uncontrolled from the outside: it starts from the loaded text and the parent keeps the latest.
  const [text, setText] = useState(markdown);
  useImperativeHandle(handleRef, () => ({ mode: "source" as const, run: () => {} }), []);
  return (
    <SourceInput
      value={text}
      disabled={!editable}
      aria-label="Document Markdown"
      className={className}
      onChange={(event) => {
        setText(event.target.value);
        onChange(event.target.value);
      }}
    />
  );
}
