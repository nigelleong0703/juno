import { uiInteractiveBlock, type UiDoc } from "@agent-desktop/client";

/** The block types this client renders (BACKEND 8.7.1). Anything else shows the doc's `text` fallback. */
const KNOWN = new Set(["text", "facts", "items", "table", "notice", "link", "image", "group", "replies", "choices", "fields"]);
const LEAF = new Set(["text", "facts", "items", "table", "notice", "link", "image"]);

/** True when every block (and every block inside a group) is one this client knows how to draw. */
export function isRenderable(doc: UiDoc): boolean {
  return doc.blocks.every((block) => {
    const type: string = block.type;
    if (!KNOWN.has(type)) return false;
    return block.type !== "group" || block.blocks.every((inner) => LEAF.has(inner.type));
  });
}

export function parseChoiceIds(value: string | undefined, multiple: boolean): string[] {
  if (!value) return [];
  if (!multiple) return [value];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** "Mac mini M4", "Ada, 2026-11-02": a decided question as one readable line. */
export function answerSummary(doc: UiDoc, answers: Record<string, string> | undefined): string {
  const block = uiInteractiveBlock(doc);
  if (!block || !answers) return "";
  if (block.type === "choices") {
    const picked = parseChoiceIds(answers[block.id], block.multiple === true);
    return block.options.filter((option) => picked.includes(option.id)).map((option) => option.label).join(", ");
  }
  return block.fields.map((field) => answers[field.id]).filter(Boolean).join(", ");
}

/** The headline of a doc: its title, else its first text block or text fallback line. */
export function docTitle(doc: UiDoc): string | undefined {
  if (doc.title) return doc.title;
  const text = doc.blocks.find((block) => block.type === "text");
  const first = text?.type === "text" ? text.text : doc.text?.split("\n").find((line) => line.trim());
  return first?.trim() || undefined;
}
