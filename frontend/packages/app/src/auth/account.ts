import { agentSchema } from "@agent-desktop/client";
import { createHttpClient } from "@agent-desktop/client/http";
import { z } from "zod";
import type { AccountUser } from "./AuthContext";
import { appClientKind } from "../platform/clientKind";

export const authInfoSchema = z.object({
  mode: z.enum(["account", "token"]),
  providers: z.array(z.string()),
});
const accountUserSchema = z.object({ id: z.string().min(1), name: z.string().min(1), email: z.string().email() });
export const authResultSchema = z.object({ token: z.string().min(1), user: accountUserSchema });
export const sessionSchema = z.object({
  session: z.object({ token: z.string().min(1), expiresAt: z.string().datetime({ offset: true }) }),
  user: accountUserSchema,
}).nullable();
export type AccountSession = NonNullable<z.infer<typeof sessionSchema>>;

export function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Enter an http:// or https:// server URL without credentials, query or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}
export function sessionSecretKey(serverUrl: string): string {
  return `agent-desktop-session:${new URL(serverUrl).origin}`;
}
/** The first letters of the first two words of a name ("Robin Lee" is "RL"); empty for a blank name. */
export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part.slice(0, 1)).join("").toUpperCase();
}
export function accountUser(user: AccountSession["user"]): AccountUser {
  return { ...user, initials: initialsOf(user.name) || user.email.slice(0, 1).toUpperCase() };
}

export class AuthenticationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const errorSchema = z.object({ message: z.string().optional(), error: z.union([
  z.string(), z.object({ message: z.string().optional() }),
]).optional() });

/** The same credential transport works with web cookies and native encrypted bearer sessions. */
export async function authRequest<T>(
  fetcher: typeof fetch, serverUrl: string, path: string, schema: z.ZodType<T>,
  options: { token?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers = new Headers();
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetcher(new URL(`/auth/${path}`, serverUrl), {
    method: options.body === undefined ? "GET" : "POST",
    headers, credentials: "include", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return readAuthResponse(response, schema);
}

async function readAuthResponse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const data: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(data);
    const detail = parsed.success ? parsed.data : null;
    const message = detail?.message ?? (typeof detail?.error === "string" ? detail.error : detail?.error?.message);
    throw new AuthenticationError(message ?? `Authentication failed (HTTP ${response.status}).`, response.status);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error("The server returned an invalid authentication response.");
  return parsed.data;
}

const legacyAgentPageSchema = z.object({
  items: z.array(agentSchema), nextCursor: z.string().nullable(),
});

/** Old agentd had no auth routes and used Hono's exact plain-text route-missing response. */
export async function discoverAuthInfo(
  fetcher: typeof fetch, serverUrl: string, legacyToken: string, signal: AbortSignal,
): Promise<z.infer<typeof authInfoSchema>> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const response = await fetcher(new URL("/auth/info", serverUrl), {
    credentials: "include", signal: boundedSignal,
  });
  const contentType = response.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  const knownLegacy404 = response.status === 404 && !response.redirected && contentType === "text/plain"
    && await response.clone().text() === "404 Not Found";
  if (!knownLegacy404) return readAuthResponse(response, authInfoSchema);
  if (!legacyToken.trim()) throw new Error("This legacy server requires an API token.");
  signal.throwIfAborted();
  // Same-origin cookies can unlock the developer tunnel transport; the explicit Bearer still
  // authenticates the legacy app. Browser same-origin policy omits cookies for custom cross-origin servers.
  const probe = await fetcher(new URL("/v1/agents?limit=1", serverUrl), {
    headers: { Authorization: `Bearer ${legacyToken}` }, credentials: "same-origin", signal: boundedSignal,
    redirect: "error",
  });
  await readAuthResponse(probe, legacyAgentPageSchema);
  signal.throwIfAborted();
  return { mode: "token", providers: [] };
}

/** Disposal aborts HTTP and SSE, including responses that arrive after switching accounts. */
export function createAccountClient(
  serverUrl: string, token: string, fetcher: typeof fetch, onUnauthorized: () => void,
) {
  const controller = new AbortController();
  const scopedFetch: typeof fetch = async (input, init) => {
    controller.signal.throwIfAborted();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const response = await fetcher(input, {
      ...init, credentials: "include",
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    });
    controller.signal.throwIfAborted();
    if (response.status === 401) onUnauthorized();
    controller.signal.throwIfAborted();
    return response;
  };
  return {
    client: createHttpClient({ baseUrl: serverUrl, getToken: () => token, fetch: scopedFetch, clientKind: appClientKind() }),
    dispose: () => controller.abort(),
  };
}
