/**
 * Settings store for persisting the server URL and API token to localStorage.
 */

const STORAGE_KEY_SERVER_URL = "agent-desktop-server-url";
const STORAGE_KEY_API_TOKEN = "agent-desktop-api-token";

export interface ServerSettings {
  serverUrl: string;
  apiToken: string;
}

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";
export const DEFAULT_API_TOKEN = "dev-token";

function safeLocalStorage(fn: () => string | null): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable
  }
}

export function getServerSettings(): ServerSettings {
  const serverUrl =
    safeLocalStorage(() => window.localStorage.getItem(STORAGE_KEY_SERVER_URL)) ||
    DEFAULT_SERVER_URL;
  const apiToken =
    safeLocalStorage(() => window.localStorage.getItem(STORAGE_KEY_API_TOKEN)) ||
    DEFAULT_API_TOKEN;

  return { serverUrl, apiToken };
}

/**
 * True once a server URL has actually been saved (by onboarding or Settings). The desktop shell
 * uses this to tell a blank install — which opens the connect page — from a configured one, since
 * `getServerSettings()` otherwise returns the localhost defaults whether or not anything is stored.
 */
export function hasSavedServerSettings(): boolean {
  return safeLocalStorage(() => window.localStorage.getItem(STORAGE_KEY_SERVER_URL)) !== null;
}

export function setServerSettings(settings: Partial<ServerSettings>): void {
  if (settings.serverUrl !== undefined) {
    safeLocalStorageSet(STORAGE_KEY_SERVER_URL, settings.serverUrl);
  }
  if (settings.apiToken !== undefined) {
    safeLocalStorageSet(STORAGE_KEY_API_TOKEN, settings.apiToken);
  }
}

const STORAGE_KEY_ONBOARDING_SEEN = "agent-desktop-onboarding-seen";

/** Whether the first-run onboarding has been finished once on this device (iOS `onboardingSeen`). */
export function hasSeenOnboarding(): boolean {
  return safeLocalStorage(() => window.localStorage.getItem(STORAGE_KEY_ONBOARDING_SEEN)) === "1";
}

export function markOnboardingSeen(): void {
  safeLocalStorageSet(STORAGE_KEY_ONBOARDING_SEEN, "1");
}

/** Onboarding shows once, and never to an install that already has a saved server. */
export function shouldShowOnboarding(): boolean {
  return !hasSeenOnboarding() && !hasSavedServerSettings();
}
