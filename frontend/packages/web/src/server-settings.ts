import type { ServerSettings } from "@agent-desktop/app";

/** Only an unconfigured browser follows its current origin (including forwarded HTTPS ports). */
export function resolveWebServerSettings(
  settings: ServerSettings,
  hasSaved: boolean,
  origin: string,
): ServerSettings {
  return hasSaved ? settings : { ...settings, serverUrl: origin };
}
