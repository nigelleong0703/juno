import { z } from 'zod';
import { DEFAULT_SCREEN_RESOLUTION } from '../contracts/computer.js';

// ---------------------------------------------------------------------------
// Config (env) — one place, so every process agrees on ports and URLs.
// ---------------------------------------------------------------------------

export const backendConfigSchema = z.object({
  /** Postgres connection string. Dev: embedded-postgres on 54329. */
  DATABASE_URL: z.string().default('postgres://postgres:postgres@127.0.0.1:54329/agents'),
  /** Port agentd's public HTTP API listens on. */
  AGENTD_PORT: z.coerce.number().default(8787),
  /** Legacy single-user bearer for agentd's token-mode app (tests only); empty refuses every token request. */
  API_TOKEN: z.string().default(''),
  /** Owner bound to API_TOKEN in token mode; empty means no single-user owner exists. */
  OWNER_ID: z.string().default(''),
  /** OpenAI-compatible model endpoint; empty → the scripted model (deterministic, offline). */
  MODEL_BASE_URL: z.string().default(''),
  MODEL_API_KEY: z.string().default('none'),
  /** Wire API for model calls: `responses` (default; encrypted reasoning items, Codex's request shape) or `chat` (chat/completions fallback). */
  MODEL_WIRE_API: z.enum(['responses', 'chat']).default('responses'),
  MODEL_ID: z.string().default('gpt-6-astra'),
  /** Reasoning tier of user-facing chat runs: `quick` (default), `standard` or `deep`. Other lanes have fixed tiers (reasoning-tier.ts). Mainly for measuring. */
  CHAT_EFFORT_TIER: z.enum(['quick', 'standard', 'deep']).default('quick'),
  /** Explicit USD-per-million-token pricing for the exact endpoint/model; empty stays unknown. */
  MODEL_PRICING_JSON: z.string().default(''),
  /**
   * The platform's own (platform-paid) fast model for background one-shots; applies only when FAST_MODEL_ID is
   * set. A blank base URL / key reuses MODEL_BASE_URL / MODEL_API_KEY. An owner's own choice still wins.
   */
  FAST_MODEL_ID: z.string().default(''),
  FAST_MODEL_BASE_URL: z.string().default(''),
  FAST_MODEL_API_KEY: z.string().default(''),
  /**
   * The platform's own System One (typed-decision) endpoint, a Jev / TypeSafe-compatible `POST {base}/v1/systemone`.
   * Applies only when both the base URL and the key are set; the model id defaults to `jev-latest`. Without it (and
   * without an owner's own System One provider) the fast model answers typed questions instead.
   */
  SYSTEM_ONE_BASE_URL: z.string().default(''),
  SYSTEM_ONE_API_KEY: z.string().default(''),
  SYSTEM_ONE_MODEL_ID: z.string().default(''),
  /** Explicit opt-in for the original jev-browser MCP on the agent Chromium. Strict '1' only; default disabled. */
  JEV_BROWSER_MCP_ENABLED: z.string().default(''),
  /** computerd's internal HTTP API (runner's computer tools; agentd's stream proxy). */
  COMPUTERD_URL: z.string().default('http://127.0.0.1:8791'),
  /** Port computerd itself listens on (used when running computerd from config). */
  COMPUTERD_PORT: z.coerce.number().default(8791),
  /** Bearer computerd requires; shared by the runner and agentd. */
  COMPUTERD_TOKEN: z.string().default(''),
  /** HMAC key for the short-lived per-screen stream tickets. */
  SCREEN_TICKET_SECRET: z.string().default(''),
  /** Stream ticket lifetime. */
  SCREEN_TICKET_TTL_MS: z.coerce.number().int().default(5 * 60 * 1000),
  E2B_API_KEY: z.string().default(''),
  E2B_API_URL: z.string().default(''),
  E2B_SANDBOX_URL: z.string().default(''),
  E2B_SANDBOX_ID: z.string().default(''),
  E2B_TEMPLATE: z.string().default('desktop-debian'),
  COMPUTER_RESOLUTION: z.string().default(DEFAULT_SCREEN_RESOLUTION),
  /** Web search provider for the web_search tool: exa | brave | tavily; empty leaves web_search unregistered. */
  SEARCH_PROVIDER: z.string().default(''),
  /** API key for SEARCH_PROVIDER; required when a provider is set. */
  SEARCH_API_KEY: z.string().default(''),
});
export type BackendConfig = z.infer<typeof backendConfigSchema>;
export const loadConfig = (env: Record<string, string | undefined> = process.env): BackendConfig =>
  backendConfigSchema.parse(env);
