/** The card's summary; posts stored before contracts 0.16 have none, so the start of the body (plain text) stands in. */
export function cardSummary(post: { summary?: string | null; body?: string | null }): string {
  if (post.summary) return post.summary;
  return (post.body ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(#{1,6}|>|[-*•·‣])\s+/gm, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}
