/**
 * Brand icons of connectors and messaging channels: one set of vector files served to web, desktop and iPhone
 * (GET /v1/brand-icons/<file>.png or .svg, public: a logo is not private). The PNG (192x192, transparent, rendered once from the
 * SVG by scripts/brand-icons-png.mjs) is what clients use, since every one of them, iPhone included, decodes it. `<file>` is a file name or any id in BRAND_ICON_FILES,
 * so a client can build the URL from a catalog id or a channel kind alone. The files live in packages/api/assets/brands.
 */
import { readFile } from 'node:fs/promises';
import type { Hono } from 'hono';

/** Catalog id (or channel kind) → file name without `.svg`. An id absent here has no brand icon. */
export const BRAND_ICON_FILES: Readonly<Record<string, string>> = {
  asana: 'asana',
  atlassian: 'atlassian',
  bilibili: 'bilibili',
  github: 'github',
  'github-reading': 'github',
  gmail: 'gmail',
  'google-calendar': 'google-calendar',
  'google-contacts': 'google-contacts',
  'google-docs': 'google-docs',
  'google-drive': 'google-drive',
  'google-maps': 'google-maps',
  'google-sheets': 'google-sheets',
  'google-tasks': 'google-tasks',
  linear: 'linear',
  notion: 'notion',
  onedrive: 'onedrive',
  'outlook-mail': 'outlook',
  'outlook-calendar': 'outlook-calendar',
  'microsoft-todo': 'todo',
  stripe: 'stripe',
  v2ex: 'v2ex',
  youtube: 'youtube',
  'youtube-account': 'youtube',
  'youtube-videos': 'youtube',
  'youtube-music': 'youtube-music',
  zapier: 'zapier',
  telegram: 'telegram',
  slack: 'slack',
  discord: 'discord',
  feishu: 'feishu',
  xiaohongshu: 'xiaohongshu',
};

/** The server-relative URL of an id's brand icon (the PNG), or undefined when it has none. */
export function brandIconUrl(id: string): string | undefined {
  const file = Object.hasOwn(BRAND_ICON_FILES, id) ? BRAND_ICON_FILES[id] : undefined;
  return file === undefined ? undefined : `/v1/brand-icons/${file}.png`;
}

const ASSETS = new URL('../assets/brands/', import.meta.url);
const NAME = /^([a-z0-9-]+)\.(svg|png)$/;
const TYPES = { svg: 'image/svg+xml', png: 'image/png' } as const;

export function registerBrandIconRoute(app: Hono): void {
  app.get('/v1/brand-icons/:file', async (c) => {
    const match = NAME.exec(c.req.param('file'));
    const name = match?.[1];
    const ext = match?.[2] as keyof typeof TYPES | undefined;
    const file = name === undefined ? undefined : Object.hasOwn(BRAND_ICON_FILES, name) ? BRAND_ICON_FILES[name] : name;
    let body: Buffer | null = null;
    if (file !== undefined && ext !== undefined) body = await readFile(new URL(`${file}.${ext}`, ASSETS)).catch(() => null);
    if (body === null) return c.json({ error: { code: 'NOT_FOUND', message: 'No such route' } }, 404);
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': TYPES[ext!],
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
        // An SVG opened on its own can never run script.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'cross-origin-resource-policy': 'cross-origin',
      },
    });
  });
}

const AVATARS = new URL('../assets/agents/', import.meta.url);
const CHARACTER = /^(bean|blue|mint|pink|purple|star)\.png$/;

/**
 * Public agent avatars (`/v1/agent-avatars/<character>.png`, 512px PNG): the picture a shared Slack app / Discord bot
 * speaks with for each agent (CHANNELS_AVATAR_BASE_URL = <public url>/v1/agent-avatars). Same headers as brand icons.
 */
export function registerAgentAvatarRoute(app: Hono): void {
  app.get('/v1/agent-avatars/:file', async (c) => {
    const match = CHARACTER.exec(c.req.param('file'));
    const body = match ? await readFile(new URL(match[0], AVATARS)).catch(() => null) : null;
    if (body === null) return c.json({ error: { code: 'NOT_FOUND', message: 'No such route' } }, 404);
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'cross-origin',
      },
    });
  });
}
