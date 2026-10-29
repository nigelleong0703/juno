import { Editor } from "@tiptap/core";
import { documentExtensions } from "./extensions";

/**
 * Markdown with the choices an editor is free to make removed, so two spellings of the same document compare equal:
 * bullet markers, emphasis markers, line endings, blank-line runs, trailing spaces and table padding.
 */
export function canonicalMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]+$/g, "")
        .replace(/^(\s*)[*+](\s)/, "$1-$2")
        .replace(/^(\s*)(\d+)\)\s/, "$1$2. ")
        .replace(/^\s*([-*_])(\s*\1){2,}\s*$/, "---")
        .replace(/__([^_\n]+)__/g, "**$1**")
        .replace(/(^|[^*\w])_([^_\n]+)_(?![*\w])/g, "$1*$2*")
        .replace(/^(\s*\|.*\|\s*)$/, (row) => row.replace(/\s*\|\s*/g, "|").replace(/^-+:?$|^:?-+:?$/g, "-")),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parse Markdown with the editor's schema and write it back. Throws when the editor cannot even parse it. */
export function roundTripMarkdown(markdown: string): string {
  const editor = new Editor({ extensions: documentExtensions(), content: markdown, contentType: "markdown" });
  try {
    return editor.getMarkdown();
  } finally {
    editor.destroy();
  }
}

/**
 * Whether opening this Markdown in the rich editor loses nothing: what the editor writes back must equal the original
 * up to formatting choices. When it does not (HTML blocks, images, footnotes, anything outside the schema), the
 * document opens in source mode instead, so a save can never silently drop content.
 */
export function survivesRoundTrip(markdown: string): boolean {
  try {
    return canonicalMarkdown(roundTripMarkdown(markdown)) === canonicalMarkdown(markdown);
  } catch {
    return false;
  }
}
