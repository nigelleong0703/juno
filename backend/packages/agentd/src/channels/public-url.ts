/**
 * The public base URL of this server as the platforms reach it (CHANNELS_PUBLIC_URL). Shared by every platform: the webhooks,
 * the OAuth redirects and the Slack manifest are built from it. Undefined selects long polling (Telegram) and refuses the
 * redirect-based installs.
 */

/** The public base URL Telegram can reach, without a trailing slash; undefined selects long polling. */
export function channelsPublicUrl(): string | undefined {
  const raw = process.env['CHANNELS_PUBLIC_URL']?.trim();
  return raw ? raw.replace(/\/+$/, '') : undefined;
}
