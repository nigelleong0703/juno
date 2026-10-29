import type { Agent, Mention } from "@agent-desktop/client";

export type MentionPart = string | { agent: Agent };
export type Recipient = { agent: Agent } | { label: string; key: string };

/** Keep code literal, including unfinished spans/fences. Offsets stay in the original text. */
function codeRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== "`" && !(char === "~" && text.startsWith("~~~", index))) { index++; continue; }
    let length = 1;
    while (text[index + length] === char) length++;
    const delimiter = char.repeat(length);
    const close = text.indexOf(delimiter, index + length);
    const end = close < 0 ? text.length : close + length;
    ranges.push({ start: index, end });
    index = end;
  }
  return ranges;
}

function tokenBoundary(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? "";
  const after = text[end] ?? "";
  // Word/email/URL fragments cannot become recipients; a sentence-ending dot still can.
  if (/[\p{L}\p{N}_.@/\\:+-]/u.test(before) || /[\p{L}\p{N}_@-]/u.test(after)) return false;
  if (after === "." && /[\p{L}\p{N}_]/u.test(text[end + 1] ?? "")) return false;
  return true;
}
function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Metadata IDs authorize recipients; the saved label identifies the token in historical text.
 * Nothing is inferred from an unannotated handle or a current agent's renamed handle.
 * A routed recipient not rendered inline precedes the body once, even if its saved label
 * occurs inside literal email/code. Unresolved labels already in the body need no extra row.
 */
export function presentMentions(text: string, mentions: Mention[], agentById?: (id: string) => Agent | undefined) {
  const recipients = new Map<string, Recipient>();
  const labels = new Map<string, Map<string, Agent>>();
  const presentInBody = new Set<string>();
  const normalizedText = text.toLowerCase();
  for (const mention of mentions) {
    const key = `${mention.kind}:${mention.id}`;
    const agent = mention.kind === "agent" ? agentById?.(mention.id) : undefined;
    const resolved = agent?.id === mention.id ? agent : undefined;
    if (!recipients.has(key)) recipients.set(key, resolved ? { agent: resolved } : { label: mention.label, key });
    if (normalizedText.includes(mention.label.toLowerCase())) presentInBody.add(key);
    if (!resolved || !mention.label.startsWith("@") || mention.label.length < 2) continue;
    const label = mention.label.toLowerCase();
    const group = labels.get(label) ?? new Map<string, Agent>();
    group.set(resolved.id, resolved);
    labels.set(label, group);
  }

  const parts: MentionPart[] = [];
  const used = new Set<string>();
  const ranges = codeRanges(text);
  const alternatives = [...labels.keys()].sort((a, b) => b.length - a.length).map(escapePattern);
  let cursor = 0;
  if (alternatives.length > 0) {
    const pattern = new RegExp(alternatives.join("|"), "giu");
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!tokenBoundary(text, start, end) || ranges.some((range) => start < range.end && end > range.start)) continue;
      const candidates = labels.get(match[0].toLowerCase());
      if (candidates?.size !== 1) continue;
      const agent = candidates.values().next().value;
      if (!agent) continue;
      if (start > cursor) parts.push(text.slice(cursor, start));
      parts.push({ agent });
      used.add(`agent:${agent.id}`);
      cursor = end;
    }
  }
  if (cursor < text.length || parts.length === 0) parts.push(text.slice(cursor));
  const beforeBody = [...recipients].flatMap(([key, recipient]) =>
    used.has(key) || ("label" in recipient && presentInBody.has(key)) ? [] : [recipient]);
  return { parts, beforeBody };
}
