/**
 * Hybrid ranking for memory search (BACKEND §5.2): BM25 over words (and Chinese characters) merged with the vector order by
 * reciprocal rank fusion. The vector order comes from SQL (pgvector, `MemoryItems.nearest`); without it (the embedder is
 * unavailable) it is the keyword ranking alone.
 */

export interface Rankable {
  id: string;
  text: string;
}

/** A vector hit must be at least this similar to count; below it the match is noise. */
export const MIN_COSINE = 0.25;
const RRF_K = 60;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const SEGMENT = new RegExp('[' + CJK + ']+|(?:(?![' + CJK + '])[\\p{L}\\p{N}])+', 'gu');
const IS_CJK = new RegExp('^[' + CJK + ']', 'u');

/** Lowercase words and numbers; Chinese, Japanese and Korean runs (no spaces between words) become single characters plus bigrams. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const run of text.toLowerCase().match(SEGMENT) ?? []) {
    if (!IS_CJK.test(run)) {
      out.push(run);
      continue;
    }
    const chars = [...run];
    out.push(...chars);
    for (let i = 0; i + 1 < chars.length; i += 1) out.push((chars[i] ?? '') + (chars[i + 1] ?? ''));
  }
  return out;
}

/** Ids of the entries that share a word with the query, best first. */
function keywordOrder(query: string, entries: readonly Rankable[]): string[] {
  const wanted = new Set(tokenize(query));
  if (wanted.size === 0 || entries.length === 0) return [];
  const docs = entries.map((entry) => tokenize(entry.text));
  const averageLength = docs.reduce((sum, tokens) => sum + tokens.length, 0) / docs.length || 1;
  const frequency = new Map<string, number>();
  for (const tokens of docs) for (const term of new Set(tokens)) if (wanted.has(term)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  const scored = entries.map((entry, index) => {
    const tokens = docs[index] ?? [];
    const counts = new Map<string, number>();
    for (const token of tokens) if (wanted.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1);
    let score = 0;
    for (const [term, count] of counts) {
      const df = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (entries.length - df + 0.5) / (df + 0.5));
      score += (idf * count * (BM25_K1 + 1)) / (count + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / averageLength));
    }
    return { id: entry.id, score };
  });
  return scored.filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((hit) => hit.id);
}

/**
 * The best `limit` entries for the query, with their fused scores (higher is better). `vectorOrder` is the ids closest to the query
 * first (already cut at MIN_COSINE, from SQL), or undefined when there is no vector search. The blend is unchanged: each list adds
 * 1 / (60 + rank) to an id, so a word match and a meaning match add up.
 */
export function rankEntries(query: string, entries: readonly Rankable[], vectorOrder: readonly string[] | undefined, limit: number): Array<{ id: string; score: number }> {
  const fused = new Map<string, number>();
  const add = (order: readonly string[]): void => order.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  add(keywordOrder(query, entries));
  if (vectorOrder !== undefined) add(vectorOrder);
  return [...fused].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
