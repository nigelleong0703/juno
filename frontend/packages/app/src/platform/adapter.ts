/**
 * Desktop capabilities injected into `packages/app` (ARCHITECTURE §9). The app never imports
 * Electron or Node: the web build supplies a browser implementation, the Electron preload
 * exposes a typed `window.platform` implementing this same interface.
 *
 * `packages/app` owns this contract (E2); `packages/desktop` owns the preload implementation and
 * `packages/web` passes the browser implementation. Only the members on `PlatformAdapter` are
 * guaranteed; the desktop-only blocks (`secrets`, `window`, `launchAtLogin`) are optional so the
 * web build stays a valid adapter.
 */

export interface PlatformNotifyOptions {
  title: string;
  body?: string;
  /** Dedupe key so the same request does not stack notifications. */
  tag?: string;
  onClick?: () => void;
  /** Buttons the OS notification can carry (desktop only; ignored on the web). */
  actions?: PlatformNotificationAction[];
}

export interface PlatformNotificationAction {
  /** Opaque id echoed back to `onAction`. */
  id: string;
  label: string;
}

/** Encrypted-at-rest key/value store (`safeStorage` in Electron, memory on the web). */
export interface PlatformSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Native window controls for the frameless/title-bar-overlay shells (VISUAL.md). */
export interface PlatformWindowControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  /** Subscribe to maximize/unmaximize; returns an unsubscribe fn. */
  onMaximizeChange(listener: (maximized: boolean) => void): () => void;
}

/** "Launch at login" toggle (Electron `app.setLoginItemSettings`). */
export interface PlatformLoginItem {
  get(): Promise<boolean>;
  set(enabled: boolean): Promise<boolean>;
}

/** Outcome of registering a server origin with the desktop shell. */
export interface ServerOriginAllowance {
  /** The normalized origin the shell now permits. */
  origin: string;
  /**
   * True when the shell had to add the origin, so the *current* document's CSP is stale: the caller
   * must reload the document and re-bootstrap before it issues any request.
   */
  reloadRequired: boolean;
}

/** What the desktop app's link to the server looks like to the user (My Mac). */
export interface MyMacLinkState {
  /** This app holds a pairing token and keeps the link up. */
  paired: boolean;
  status: "connecting" | "online" | "offline" | "unauthorized";
  /** Commands the agents are running on this Mac right now, and the newest one's first line. */
  running: number;
  command?: string;
  /** The user pressed Stop: nothing runs on this Mac until they resume. */
  stopped: boolean;
  /** This Mac's name, offered as the pairing name. */
  deviceName: string;
  /** The folder the agents work in (`~/Juno`, absolute). */
  folder: string;
}

/** Permissions and Chrome bridge on this desktop; no account credentials leave the shell. */
export interface MyMacDesktopState {
  screen: boolean;
  accessibility: boolean;
  audio: boolean;
  chrome: boolean;
  detail?: string;
}

/** The Mac as a computer for agents (desktop only): the link daemon lives in the shell, the token in the Keychain. */
export interface PlatformMyMac {
  desktopStatus?(): Promise<MyMacDesktopState>;
  requestPermission?(kind: "screen" | "accessibility"): Promise<void>;
  setupChrome?(): Promise<void>;
  state(): Promise<MyMacLinkState>;
  onState(listener: (state: MyMacLinkState) => void): () => void;
  /** Keep the pairing the server just issued and bring the link up. */
  connect(pairing: { id: string; url: string; token: string }): Promise<void>;
  /** Forget the pairing and take the link down (the server-side revoke is the caller's). */
  disconnect(): Promise<void>;
  /** The Stop button: cancel what is running and refuse new work, or let it continue. */
  setStopped(stopped: boolean): void;
}

export interface PlatformAdapter {
  /** Human-readable platform id, e.g. "web" | "darwin" | "win32". */
  readonly id: string;
  /** True when running inside the Electron shell. */
  readonly isDesktop: boolean;
  /** macOS window chrome shows traffic lights inset into our title bar. */
  readonly hasTrafficLights: boolean;
  /** Raise an OS notification (falls back to a no-op where unsupported). */
  notify(options: PlatformNotifyOptions): void;
  /** Open a URL in the user's browser. */
  openExternal(url: string): void;
  /** Set the dock/taskbar badge count (0 clears it). */
  setBadge(count: number): void;
  /**
   * Desktop only: tell the native window which appearance to use, so native materials
   * (vibrancy) and window chrome follow the app's own theme instead of the OS appearance.
   */
  setAppearance?(appearance: "dark" | "light" | "system"): void;
  /**
   * Desktop only: register a user-chosen server origin with the shell so its CSP permits requests
   * to it. Resolves to the normalized origin and whether the policy changed, or `null` when the
   * value is rejected or there is no shell CSP (web). A document's CSP is fixed at load, so a
   * `changed` result means "reload before fetching".
   */
  allowServerOrigin?(url: string): Promise<ServerOriginAllowance | null>;
  /** Optional: encrypted secret storage. Present only in the desktop shell. */
  readonly secrets?: PlatformSecretStore;
  /** Optional: native window controls. Present only in the desktop shell. */
  readonly window?: PlatformWindowControls;
  /** Optional: launch-at-login toggle. Present only in the desktop shell. */
  readonly launchAtLogin?: PlatformLoginItem;
  /** Optional: this Mac as a computer for agents. Present only in the desktop shell. */
  readonly myMac?: PlatformMyMac;
  /** Optional: ask the OS for notification permission; resolves to whether it is granted. */
  requestNotificationPermission?(): Promise<boolean>;
}

/** Narrowing helper: the desktop-only capabilities are all present. */
export interface DesktopPlatformAdapter extends PlatformAdapter {
  readonly isDesktop: true;
  readonly secrets: PlatformSecretStore;
  readonly window: PlatformWindowControls;
}

export function hasDesktopCapabilities(
  platform: PlatformAdapter,
): platform is DesktopPlatformAdapter {
  return Boolean(platform.isDesktop && platform.secrets && platform.window);
}

/**
 * Browser implementation used by `packages/web` and by Electron outside the preload path.
 * Secrets live in memory only (never persisted); window controls are no-ops.
 */
export function createWebPlatform(): PlatformAdapter {
  const secrets = new Map<string, string>();

  return {
    id: "web",
    isDesktop: false,
    hasTrafficLights: false,
    notify({ title, body, tag, onClick }) {
      if (typeof window === "undefined" || !("Notification" in window)) return;
      try {
        if (Notification.permission === "granted") {
          const notification = new Notification(title, { body, tag });
          if (onClick) notification.onclick = onClick;
        }
      } catch {
        /* notification construction can throw in sandboxed frames — ignore */
      }
    },
    openExternal(url) {
      if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
    },
    setBadge(count) {
      // Browsers expose no standard badge API; the desktop preload overrides this.
      if (typeof document !== "undefined") {
        document.title = count > 0 ? `(${count}) Juno` : "Juno";
      }
    },
    async allowServerOrigin() {
      // No shell CSP exists on the web; the browser enforces its own origin policy.
      return null;
    },
    secrets: {
      async get(key) {
        return secrets.get(key) ?? null;
      },
      async set(key, value) {
        secrets.set(key, value);
      },
      async delete(key) {
        secrets.delete(key);
      },
    },
    async requestNotificationPermission() {
      if (typeof window === "undefined" || !("Notification" in window)) return false;
      try {
        return (await Notification.requestPermission()) === "granted";
      } catch {
        return false;
      }
    },
  };
}

/** Singleton browser adapter (matches the previous `webPlatform` export). */
export const webPlatform: PlatformAdapter = createWebPlatform();
