/**
 * Web search behind one small interface. The provider is chosen by env (SEARCH_PROVIDER=exa|brave|tavily with
 * SEARCH_API_KEY). OCX offers no general search API (its /v1/alpha/search relay is Codex's private envelope and
 * its only search sidecar is a paid model turn), so no provider means web_search is not registered at all.
 */

import { z } from 'zod';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  /** Result image / favicon URL when the provider returns one (Exa). */
  image?: string;
  favicon?: string;
  /** Longer page text (extended Exa searches only), capped by the provider. */
  text?: string;
}

/** Categories of Exa's search API (https://exa.ai/docs/reference/search, `category`). */
export const SEARCH_CATEGORIES = ['news', 'company', 'publication', 'personal site', 'financial report', 'people'] as const;
export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

/**
 * Optional narrowing. Support per provider (a param a provider lacks is dropped, nothing is reported):
 * - exa: all. `since` -> startPublishedDate, `domains` -> includeDomains, `category` -> category. Exa returns 400 when
 *   a date is sent with category company/people, so `since` is not sent for those two.
 * - brave: `since` -> freshness date range; `domains` -> a `site:` clause in the query; `category` unsupported.
 * - tavily: `since` -> start_date, `domains` -> include_domains, `category` news -> topic "news" (others unsupported).
 */
export interface WebSearchFilters {
  /** ISO date or date-time: only results published after it. */
  since?: string;
  domains?: string[];
  category?: SearchCategory;
  /**
   * extended = a more thorough, slower, costlier search. exa: `type: 'deep'` plus a capped page text next to the highlights;
   * tavily: `search_depth: 'advanced'`; brave: nothing beyond the larger result count the caller asks for.
   */
  mode?: 'standard' | 'extended';
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, limit: number, signal?: AbortSignal, filters?: WebSearchFilters): Promise<WebSearchResult[]>;
}

export interface SearchEnv {
  SEARCH_PROVIDER: string;
  SEARCH_API_KEY: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const SEARCH_TIMEOUT_MS = 15_000;
/** Deep searches synthesise across several steps; the tool's own 60 s limit still bounds the whole call. */
const EXTENDED_SEARCH_TIMEOUT_MS = 35_000;
const EXTENDED_TEXT_MAX_CHARS = 2_000;
const SNIPPET_MAX_CHARS = 500;
const PROVIDERS = ['exa', 'brave', 'tavily'] as const;

const braveResponse = z.object({ web: z.object({ results: z.array(z.object({ title: z.string().optional(), url: z.string().optional(), description: z.string().optional() })).optional() }).optional() });
const tavilyResponse = z.object({ results: z.array(z.object({ title: z.string().optional(), url: z.string().optional(), content: z.string().optional(), published_date: z.string().optional() })).optional() });

const exaResponse = z.object({
  results: z.array(z.object({
    title: z.string().nullish(), url: z.string().nullish(), publishedDate: z.string().nullish(), image: z.string().nullish(), favicon: z.string().nullish(),
    highlights: z.array(z.string()).nullish(), summary: z.string().nullish(), text: z.string().nullish(),
  })).optional(),
});

function cleanSnippet(raw: string | undefined): string {
  return (raw ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX_CHARS);
}

/** Keeps only results that have a public http(s) link; the title falls back to the link. */
function toResults(rows: ReadonlyArray<{ title?: string | undefined; url?: string | undefined; snippet: string; publishedDate?: string | undefined; image?: string | undefined; favicon?: string | undefined; text?: string | undefined }>, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    if (row.url === undefined) continue;
    let parsed: URL;
    try {
      parsed = new URL(row.url);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    const title = (row.title ?? '').replace(/<[^>]*>/g, '').trim() || parsed.href;
    out.push({
      title, url: parsed.href, snippet: row.snippet,
      ...(row.publishedDate ? { publishedDate: row.publishedDate } : {}),
      ...(row.image ? { image: row.image } : {}),
      ...(row.favicon ? { favicon: row.favicon } : {}),
      ...(row.text ? { text: row.text } : {}),
    });
  }
  return out;
}

function timeoutSignal(signal?: AbortSignal, ms = SEARCH_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** Exa Search API: https://exa.ai/docs/reference/search (POST /search, x-api-key; results carry title, url, publishedDate, image, favicon, highlights, summary). */
function exaProvider(apiKey: string, fetchImpl: FetchLike): WebSearchProvider {
  return {
    name: 'exa',
    async search(query, limit, signal, filters) {
      const dated = filters?.category !== 'company' && filters?.category !== 'people';
      const extended = filters?.mode === 'extended';
      const response = await fetchImpl('https://api.exa.ai/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          query, numResults: limit,
          type: extended ? 'deep' : 'auto',
          contents: extended ? { highlights: true, text: { maxCharacters: EXTENDED_TEXT_MAX_CHARS } } : { highlights: true },
          ...(filters?.since && dated ? { startPublishedDate: filters.since } : {}),
          ...(filters?.domains?.length ? { includeDomains: filters.domains } : {}),
          ...(filters?.category ? { category: filters.category } : {}),
        }),
        signal: timeoutSignal(signal, extended ? EXTENDED_SEARCH_TIMEOUT_MS : SEARCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`exa search failed with HTTP ${response.status}`);
      const body = exaResponse.parse(await response.json());
      return toResults((body.results ?? []).map((row) => ({
        title: row.title ?? undefined,
        url: row.url ?? undefined,
        snippet: cleanSnippet(row.summary || (row.highlights ?? []).join(' ')),
        publishedDate: row.publishedDate ?? undefined,
        image: row.image ?? undefined,
        favicon: row.favicon ?? undefined,
        text: extended ? (row.text ?? undefined) : undefined,
      })), limit);
    },
  };
}

function braveProvider(apiKey: string, fetchImpl: FetchLike): WebSearchProvider {
  return {
    name: 'brave',
    async search(query, limit, signal, filters) {
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      const sites = (filters?.domains ?? []).map((domain) => `site:${domain}`).join(' OR ');
      url.searchParams.set('q', sites ? `${query} (${sites})` : query);
      const since = filters?.since?.slice(0, 10);
      if (since) url.searchParams.set('freshness', `${since}to${new Date().toISOString().slice(0, 10)}`);
      url.searchParams.set('count', String(limit));
      const response = await fetchImpl(url, { headers: { accept: 'application/json', 'X-Subscription-Token': apiKey }, signal: timeoutSignal(signal) });
      if (!response.ok) throw new Error(`brave search failed with HTTP ${response.status}`);
      const body = braveResponse.parse(await response.json());
      return toResults((body.web?.results ?? []).map((row) => ({ title: row.title, url: row.url, snippet: cleanSnippet(row.description) })), limit);
    },
  };
}

function tavilyProvider(apiKey: string, fetchImpl: FetchLike): WebSearchProvider {
  return {
    name: 'tavily',
    async search(query, limit, signal, filters) {
      const response = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query, max_results: limit,
          ...(filters?.mode === 'extended' ? { search_depth: 'advanced' } : {}),
          ...(filters?.since ? { start_date: filters.since.slice(0, 10) } : {}),
          ...(filters?.domains?.length ? { include_domains: filters.domains } : {}),
          ...(filters?.category === 'news' ? { topic: 'news' } : {}),
        }),
        signal: timeoutSignal(signal),
      });
      if (!response.ok) throw new Error(`tavily search failed with HTTP ${response.status}`);
      const body = tavilyResponse.parse(await response.json());
      return toResults((body.results ?? []).map((row) => ({ title: row.title, url: row.url, snippet: cleanSnippet(row.content), publishedDate: row.published_date })), limit);
    },
  };
}

/**
 * undefined when SEARCH_PROVIDER is empty. An unknown provider or a missing key throws, so a misconfigured
 * deployment fails at boot instead of silently losing the tool (same fail-fast rule as the model settings).
 */
export function createWebSearchProvider(env: SearchEnv, fetchImpl: FetchLike = (input, init) => fetch(input, init)): WebSearchProvider | undefined {
  const name = env.SEARCH_PROVIDER.trim().toLowerCase();
  if (name === '') return undefined;
  if (!(PROVIDERS as readonly string[]).includes(name)) {
    throw new Error(`SEARCH_PROVIDER must be one of ${PROVIDERS.join(', ')} (got "${name}")`);
  }
  const apiKey = env.SEARCH_API_KEY.trim();
  if (apiKey === '') throw new Error('SEARCH_API_KEY is required when SEARCH_PROVIDER is set');
  return name === 'exa' ? exaProvider(apiKey, fetchImpl) : name === 'brave' ? braveProvider(apiKey, fetchImpl) : tavilyProvider(apiKey, fetchImpl);
}
