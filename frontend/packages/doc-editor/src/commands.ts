import type { Editor } from "@tiptap/core";

/** The formatting actions the toolbars (web) and the native bar (iOS, through the bridge) can ask for. */
export const EDITOR_COMMANDS = [
  "bold",
  "italic",
  "strike",
  "code",
  "heading1",
  "heading2",
  "heading3",
  "paragraph",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
  "table",
  "rule",
  "link",
  "undo",
  "redo",
] as const;
export type EditorCommand = (typeof EDITOR_COMMANDS)[number];

/** Which commands are on at the cursor, plus whether undo and redo have anything to do. */
export type EditorState = Partial<Record<EditorCommand, boolean>>;

export function isEditorCommand(value: unknown): value is EditorCommand {
  return typeof value === "string" && (EDITOR_COMMANDS as readonly string[]).includes(value);
}

/** Run one command. `link` takes the address (empty removes the link). */
export function runCommand(editor: Editor, command: EditorCommand, argument?: string): void {
  const chain = editor.chain().focus();
  switch (command) {
    case "bold": chain.toggleBold().run(); break;
    case "italic": chain.toggleItalic().run(); break;
    case "strike": chain.toggleStrike().run(); break;
    case "code": chain.toggleCode().run(); break;
    case "heading1": chain.toggleHeading({ level: 1 }).run(); break;
    case "heading2": chain.toggleHeading({ level: 2 }).run(); break;
    case "heading3": chain.toggleHeading({ level: 3 }).run(); break;
    case "paragraph": chain.setParagraph().run(); break;
    case "bulletList": chain.toggleBulletList().run(); break;
    case "orderedList": chain.toggleOrderedList().run(); break;
    case "taskList": chain.toggleTaskList().run(); break;
    case "blockquote": chain.toggleBlockquote().run(); break;
    case "codeBlock": chain.toggleCodeBlock().run(); break;
    case "table": chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
    case "rule": chain.setHorizontalRule().run(); break;
    case "link":
      if (argument) chain.extendMarkRange("link").setLink({ href: argument }).run();
      else chain.extendMarkRange("link").unsetLink().run();
      break;
    case "undo": chain.undo().run(); break;
    case "redo": chain.redo().run(); break;
  }
}

export function editorState(editor: Editor): EditorState {
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    strike: editor.isActive("strike"),
    code: editor.isActive("code"),
    heading1: editor.isActive("heading", { level: 1 }),
    heading2: editor.isActive("heading", { level: 2 }),
    heading3: editor.isActive("heading", { level: 3 }),
    bulletList: editor.isActive("bulletList"),
    orderedList: editor.isActive("orderedList"),
    taskList: editor.isActive("taskList"),
    blockquote: editor.isActive("blockquote"),
    codeBlock: editor.isActive("codeBlock"),
    link: editor.isActive("link"),
    undo: editor.can().undo(),
    redo: editor.can().redo(),
  };
}
