/** One learned rule: a sentence, and the claim it rests on when the file names one (`[claim:<id>]`). */
export interface ReplyRule {
  text: string;
  claimId?: string;
}

/** ALIGNMENT_SYNTHESIS.md for the profile: the rules, and the day the file says it was last updated from. */
export interface ReplyStyle {
  rules: ReplyRule[];
  updated?: Date;
}

const CLAIM = /\s*\[claim:([^\]\s]+)\]/g;
const UPDATED = /^\W*last updated(?: from)?\s+(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/i;
const BULLET = /^\s*[-*]\s+(.*)$/;

/** A line without its trailing claim markers, and the first claim id it carried. */
function withoutClaim(line: string): ReplyRule {
  let claimId: string | undefined;
  const text = line.replace(CLAIM, (_marker, id: string) => {
    claimId ??= id;
    return "";
  });
  return claimId === undefined ? { text: text.trim() } : { text: text.trim(), claimId };
}

/** ALIGNMENT_SYNTHESIS.md for one agent: the shared body plus this agent's own `## <name>（<id>）` section. */
export function replyStyleFor(text: string, agentId: string): string {
  const parts = text.split(/^(?=## )/m);
  const kept = parts.filter((part) => {
    const heading = /^## .*（([^）]*)）\s*$/m.exec(part.split("\n")[0] ?? "");
    return heading === null || heading[1] === agentId;
  });
  return kept.join("").trim();
}

/**
 * Reads the file for display: the `# …` title and `## …` headings are dropped, "Last updated from <date> …" becomes the
 * `updated` day, and each "- " bullet is one rule with its `[claim:<id>]` marker stripped (the id kept). A file with no bullets
 * falls back to its plain lines as rules; a file with no header and no date line reads the same way.
 */
export function parseReplyStyle(content: string): ReplyStyle {
  let updated: Date | undefined;
  const bullets: ReplyRule[] = [];
  const plain: ReplyRule[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const date = UPDATED.exec(line);
    if (date) {
      const [, year, month, day, hour, minute] = date;
      updated ??= new Date(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0));
      continue;
    }
    const bullet = BULLET.exec(line);
    const rule = withoutClaim(bullet ? (bullet[1] ?? "") : line);
    if (rule.text === "") continue;
    (bullet ? bullets : plain).push(rule);
  }
  const rules = bullets.length > 0 ? bullets : plain;
  return updated ? { rules, updated } : { rules };
}
