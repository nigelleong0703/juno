/**
 * Bounded asset protocol for the packaged desktop renderer (AL2). Pure helpers with no Electron
 * import, so the path-confinement policy unit-tests in plain Node (same split as
 * `server-origin.ts`).
 *
 * Serving the packaged renderer with `loadFile` gives the document the opaque origin `null`,
 * which the account backend rejects with HTTP 403 MISSING_OR_NULL_ORIGIN. The packaged window
 * instead loads `electron://app/index.html`: a standard + secure custom scheme (registered
 * privileged before `app` is ready) whose origin is already in the backend CORS allow-list and
 * the Better Auth trusted origins, so cookie login sends `Origin: electron://app`.
 *
 * Confinement: only host `app`, only files under the renderer root, no credentials/ports, no
 * traversal (raw, percent-encoded or doubly encoded), no backslashes, no null bytes, correct
 * MIME per extension. Anything else resolves to `null` and the protocol handler answers 404.
 */
import { relative, resolve, sep } from "node:path";

export const APP_SCHEME = "electron";
export const APP_HOST = "app";
export const APP_ORIGIN = APP_SCHEME + "://" + APP_HOST;
export const APP_URL = APP_ORIGIN + "/index.html";

const MAX_DECODE_ROUNDS = 8;
const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);

const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  txt: "text/plain; charset=utf-8",
};

/** Content-Type for a resolved asset path; unknown extensions get a safe default. */
export function mimeForPath(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filePath.slice(dot + 1).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Decode until stable so `%2e%2e`, `%252e%252e` and deeper nestings all surface as the
 * `..` they mean. Returns `null` when the value is malformed or never stabilises.
 */
function fullyDecode(value: string): string | null {
  let current = value;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
}

/** Lexical path of the raw request URL (query/fragment stripped) for a pre-parse scan. */
function rawPathOf(requestUrl: string): string {
  let end = requestUrl.length;
  const queryAt = requestUrl.indexOf("?");
  if (queryAt >= 0 && queryAt < end) end = queryAt;
  const hashAt = requestUrl.indexOf("#");
  if (hashAt >= 0 && hashAt < end) end = hashAt;
  return requestUrl.slice(0, end);
}

function stripLeadingSlashes(value: string): string {
  let out = value;
  while (out.startsWith("/")) out = out.slice(1);
  return out;
}

/**
 * Resolve an `electron://app/...` request URL to an absolute file under `rendererRoot`, or
 * `null` when the request must be refused. Query and fragment never affect the mapping;
 * a bare directory maps to its `index.html`.
 */
export function resolveAssetPath(rendererRoot: string, requestUrl: string): string | null {
  // Scan before URL parsing: WHATWG normalises literal `..` segments away, so `..` must be
  // refused here (raw, encoded or doubly encoded) rather than only after parsing.
  for (const segment of rawPathOf(requestUrl).split("/")) {
    const raw = fullyDecode(segment);
    if (raw === null) return null;
    if (raw === ".." || raw.includes(BACKSLASH) || raw.includes(NUL)) return null;
  }
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== APP_SCHEME + ":") return null;
  if (url.hostname !== APP_HOST) return null;
  if (url.username || url.password || url.port) return null;

  const decoded = fullyDecode(url.pathname);
  if (!decoded || !decoded.startsWith("/")) return null;
  if (decoded.includes(NUL)) return null;
  const segments = decoded.split("/");
  for (const segment of segments) {
    if (segment === "..") return null;
    if (segment.includes(BACKSLASH)) return null;
  }

  let rel = stripLeadingSlashes(decoded);
  if (rel === "" || rel.endsWith("/")) rel += "index.html";

  const root = resolve(rendererRoot);
  const resolved = resolve(root, rel);
  if (!isAssetPathConfined(root, resolved)) return null;
  return resolved;
}

export function isAssetPathConfined(rendererRootReal: string, resolvedReal: string): boolean {
  const root = resolve(rendererRootReal);
  const resolved = resolve(resolvedReal);
  const relToRoot = relative(root, resolved);
  if (relToRoot === "") return false;
  if (relToRoot === ".." || relToRoot.startsWith(".." + sep)) return false;
  return true;
}
