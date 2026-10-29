/**
 * Agent prose, made to read the way it was written (same rules as iOS `AgentMarkdown.normalizingProse`):
 * `•` / `·` / `‣` lines become list items and a single newline is a line break (chat-style). CJK emphasis
 * (`**欧洲：**OpenAI`) is handled by Streamdown's `@streamdown/cjk` plugin. Fenced code and table rows are untouched.
 */
export function normalizeAgentProse(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  return lines
    .map((raw, i) => {
      const trimmed = raw.trim();
      if (/^(```|~~~)/.test(trimmed)) {
        inFence = !inFence;
        return raw;
      }
      if (inFence) return raw;
      let line = raw;
      if (/^[•·‣] /.test(trimmed)) line = `- ${trimmed.slice(2)}`;
      const next = (lines[i + 1] ?? "").trim();
      return next && trimmed && !trimmed.startsWith("|") ? `${line}  ` : line;
    })
    .join("\n");
}
