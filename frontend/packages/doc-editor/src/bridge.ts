import { isEditorCommand, type EditorCommand, type EditorState } from "./commands";
import type { EditorMode } from "./DocumentEditor";

/** What the page tells the app (iOS: `WKScriptMessageHandler` named `junoEditor`). */
export type EditorOutgoing =
  | { type: "ready" }
  | { type: "mode"; mode: EditorMode }
  | { type: "change"; markdown: string }
  | { type: "state"; state: EditorState };

/** What the app asks of the page (iOS: `evaluateJavaScript("junoEditor.receive(...)")`). */
export type EditorIncoming =
  | { type: "setMarkdown"; markdown: string }
  | { type: "setEditable"; editable: boolean }
  | { type: "command"; command: EditorCommand; argument?: string };

/** Reads an incoming message; anything that is not one of the three shapes is ignored. */
export function parseIncoming(raw: unknown): EditorIncoming | null {
  if (typeof raw !== "object" || raw === null) return null;
  const message = raw as Record<string, unknown>;
  if (message.type === "setMarkdown" && typeof message.markdown === "string") return { type: "setMarkdown", markdown: message.markdown };
  if (message.type === "setEditable" && typeof message.editable === "boolean") return { type: "setEditable", editable: message.editable };
  if (message.type === "command" && isEditorCommand(message.command)) {
    return typeof message.argument === "string" ? { type: "command", command: message.command, argument: message.argument } : { type: "command", command: message.command };
  }
  return null;
}
