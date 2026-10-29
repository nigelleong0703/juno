/**
 * Hybrid ranking for memory search (BACKEND §5.2): BM25 over words (and Chinese characters) merged with cosine similarity of
 * the vectors by reciprocal rank fusion. Without vectors (the embedder is unavailable) it is the keyword ranking alone.
 */

export interface Rankable {
  id: string;
  text: string;
  embedding?: number[];
}

/** A vector hit must be at least this similar to count; below it the match is noise. */
const MIN_COSINE = 0.25;
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

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
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

function vectorOrder(queryEmbedding: readonly number[], entries: readonly Rankable[]): string[] {
  return entries
    .flatMap((entry) => (entry.embedding === undefined ? [] : [{ id: entry.id, score: cosine(queryEmbedding, entry.embedding) }]))
    .filter((hit) => hit.score >= MIN_COSINE)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((hit) => hit.id);
}

/** The best `limit` entries for the query, with their fused scores (higher is better). */
export function rankEntries(query: string, entries: readonly Rankable[], queryEmbedding: readonly number[] | undefined, limit: number): Array<{ id: string; score: number }> {
  const fused = new Map<string, number>();
  const add = (order: string[]): void => order.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  add(keywordOrder(query, entries));
  if (queryEmbedding !== undefined) add(vectorOrder(queryEmbedding, entries));
  return [...fused].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}
