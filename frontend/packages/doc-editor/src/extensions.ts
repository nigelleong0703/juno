import { Markdown } from "@tiptap/markdown";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";

/**
 * The editor's schema is the GFM subset documents are stored in (BACKEND 5.11a): headings, lists, task lists, tables,
 * links, code, quotes and rules. Underline is off because Markdown cannot say it; images are not in the schema, so a
 * document that has them is opened in source mode by the round-trip guard.
 */
export function documentExtensions() {
  return [
    StarterKit.configure({ underline: false, link: { openOnClick: false, autolink: true } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Markdown,
  ];
}
