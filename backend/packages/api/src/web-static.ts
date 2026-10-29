/**
 * Optional same-origin web serving: when WEB_DIST points at the built web app directory (from the frontend repository) the
 * gateway serves it, with an index.html fallback for client-side routes. API surfaces (/v1, /auth,
 * /healthz) are never answered from here, so an unknown API path stays a JSON 404.
 */
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function isApiPath(pathname: string): boolean {
  return pathname === '/healthz' || /^\/(v1|auth)(\/|$)/.test(pathname);
}

async function readIfFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

function fileResponse(body: Buffer, path: string, method: string, root: string): Response {
  // Vite fingerprints everything under /assets, so it can be cached forever; index.html must not be.
  const immutable = path.startsWith(join(root, 'assets') + sep);
  return new Response(method === 'HEAD' ? null : new Uint8Array(body), {
    headers: {
      'content-type': CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
}

/** Returns a handler that answers a GET/HEAD for the web build, or null when the path is not the web build's. */
export function createWebStaticHandler(distDir: string): (method: string, pathname: string) => Promise<Response | null> {
  const root = resolve(distDir);
  return async (method, pathname) => {
    if ((method !== 'GET' && method !== 'HEAD') || isApiPath(pathname)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    const requested = join(root, normalize(decoded));
    if (requested !== root && !requested.startsWith(root + sep)) return null;
    const asset = decoded.endsWith('/') ? null : await readIfFile(requested);
    if (asset) return fileResponse(asset, requested, method, root);
    // A missing file with an extension is a missing asset, not a client route: do not hand back HTML.
    if (extname(decoded) !== '') return null;
    const indexPath = join(root, 'index.html');
    const index = await readIfFile(indexPath);
    return index ? fileResponse(index, indexPath, method, root) : null;
  };
}
