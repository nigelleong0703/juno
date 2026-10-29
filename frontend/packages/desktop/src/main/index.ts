import { app, BrowserWindow, dialog, Menu, Notification, Tray, nativeImage, nativeTheme, protocol, safeStorage, screen, session, shell, systemPreferences, ipcMain } from "electron";
import { execFile } from "node:child_process";
import { createMacHost } from "./mac-host";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electronUpdater from "electron-updater";
import { observeStartup, revealWindow, reportStartupFailure, startupLog } from "./startup";
import { APP_ORIGIN, APP_SCHEME, APP_URL, isAssetPathConfined, mimeForPath, resolveAssetPath } from "./asset-protocol";
import { buildContentSecurityPolicy, normalizeServerOrigin, registerServerOrigin } from "./server-origin";
import { SHELL_HEADER_HEIGHT_PX, TRAFFIC_LIGHT_POSITION } from "@agent-desktop/app/window-chrome";
import type { MyMacLinkState } from "@agent-desktop/app";
import { commandPath, createMyMac, junoFolder, parsePairing, type MyMac } from "./my-mac";

/**
 * Electron main process. Owns the window chrome (VISUAL.md), the tray, OS
 * notifications for pending approvals, the `agentdesktop://` deep link, launch-at-login, secret
 * storage via `safeStorage`, and a CSP that allows the configured server + websocket stream.
 *
 * Security posture: contextIsolation on, sandbox on, nodeIntegration off, and a strict CSP. The
 * renderer only ever reaches the OS through the preload's typed `window.platform`.
 */

const desktopMainDirectory = dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;

// Brand rename (BR6): freeze the pre-rename profile directory so settings and
// account sessions survive the visible rename (now Juno). app.setName only
// changes the display name (menu bar, Dock); the userData path stays pinned
// to the existing '@agent-desktop/desktop' profile.
// AGENT_DESKTOP_USER_DATA lets an automated run use a throwaway profile (and its own
// single-instance lock) beside the real, possibly running app.
app.setPath("userData", process.env.AGENT_DESKTOP_USER_DATA || join(app.getPath("appData"), "@agent-desktop", "desktop"));
app.setName("Juno");

const APP_PROTOCOL = "agentdesktop";
const DEFAULT_BG = "#0b0f14";

// The packaged client's documented default server (E5). It is always in the CSP allow-list, so a
// blank install can reach 127.0.0.1:8787 without any configuration.
const DEFAULT_SERVER_ORIGIN = "http://127.0.0.1:8787";
const STREAM_ORIGINS = (process.env.AGENT_DESKTOP_STREAM_ORIGINS ?? "").split(",").filter(Boolean);
const isDev = !app.isPackaged;
// The renderer dev server's port: must match electron.vite.config.ts (same env var, 5200 by default; 5199 is the web app).
const DEV_PORT = process.env.JUNO_DESKTOP_PORT ?? "5200";
const DEV_ORIGINS = isDev ? [`http://localhost:${DEV_PORT}`, `ws://localhost:${DEV_PORT}`] : [];

/**
 * Every http(s) origin the renderer may talk to. Seeded from the default + the env override at
 * module load, the persisted user choice is added before the window opens, and the set grows as
 * the user connects to a new server over the validated `platform:server:allow-origin` IPC.
 */
const allowedServerOrigins = new Set<string>([DEFAULT_SERVER_ORIGIN]);
const envServerOrigin = normalizeServerOrigin(process.env.AGENT_DESKTOP_SERVER_ORIGIN ?? "");
if (envServerOrigin) allowedServerOrigins.add(envServerOrigin);

// The tray icon is the Juno bean silhouette (44px = 22pt @2x, black on transparent so macOS tints it as a template image),
// shipped inline so the app has no binary asset dependency.
const TRAY_ICON_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAACwAAAAsCAYAAAAehFoBAAAEMElEQVR4nMWZS8hVVRTHf/fe76uvhxpqRA+EsMKJUIIiQhnRgzCa9DAIiiaNUhyEQRGCCDoThSYfhYMwKBpIEUFID2pQWViUFD2UigqxopdQn9+9J1b8lyx259x79jlHW7DY9+znf6+9XnvfHvnUU1kAa4GbgVXAeuB31b8MzAJHkv5nnXzxAfAocExAytjabv0/QEawxucD+wKwITAqYWv7C3gVWA70w4bPCplUjR4TmDmBrZKwb6TQacQ5xgmkE/KJFgKfC8w4sM7z4neAa8eA6ncN3CVzS3LkdXio8j3gnDGApoHFJUKq3Nk4cgu/QxMZYDLHLpQaFSWgHtApfCT7uFz9WknaBr8RjrrI4F+Bk8A2YInm8lO7qeTEDgdpZ4P2ARcAnyXH7DzSJmK9/34fuAq4X98mTaQeRjs13o3YT+FBtU81UQkHPpjQVjbfHuArYL/AX5y0z5fgMcAzZQvlADaf+ktS5/po9Y8Az4V6P5njMigUTL5Pxr6mvtOqm5akP1R7jr2cJl/8QKLDXppvNloAfKG6Uyq3B6OzUL1GpzEI8z6kUzB1+AS4J1k3m1wVdgeg0VBuCFJ8IQH8G/AE8KK+zcjKyIzxOuCitmAj4E3BwKJh3RX6vlVhmIX4IHA7sDQAS1VzXETMAnxv8AoRlIG8FLgP+DsJLqMSD2L8tObsJ8A7Cc8+6TLgRALa+UcZZp3INwJ+Bq4OYDsnn/TZkuCRE6qLMPbJXBXIcWt+XPsEME1YHExdKpq4rHGAPRg4O6APgKMlOUVultUD/sg1sCrALjFPI13vBroGva5+ORKN5Bv7Jhhja5pR9HoGeDiJ6Xc21N0iGXdQnsd9eOOdX6iQGRc5EJz6coXjNqCLwBua+l8fcHeIVs72vVnt5wKHJgSIOjynDc9WBJD/UL9CwtcEybkqmCtard9zMhha6l9fay6t62VSwD7gU7UNQvo3peTF+33ZAmi6/o3ASs2b42r/JT+a2eT4DinS+Sk8XhJAmvC8yq1t8wgDfRuwQ7cESw8JKrK1I8BDqd/bEy6pjagX+PmOJfxuEEYl4KkJ4KI+eVSzyS8Brp80eSadDPbSSSAhbGBtcGdt/fBIpV2drkzWqQRQl1yayzR21IGEe5rnMl2f4jqtARfBDcXvLqio06kp4Cvy8Uyc16S6aHy3Bk665bgyisHiOyZQ7kNKEZKjLqmnu+APk9SjqaQaPW5UUBEeWb5O6loBjkf3bYcGV6j8GPhTa3QmYXc3L3UUQougavuTNTohBzmj99y2ofmUyqfOgDGfJs+mNgTATaLdvMrjdSJcW/LEe1fIuOpKehgkezhcCs7oP0xRf/cmeUHV32DDBLg9p67o6i0tF/RG/elSR8JHgC160c8G20XiYmRAztO77jo9qdoN29JXU5WfZKSvAG/qCdbIE6ja9A8qwSf1mOuB8gAAAABJRU5ErkJggg==";

interface PendingItem {
  id: string;
  title: string;
  agentName?: string;
  /** Where "Open" goes: the conversation the request was raised in. */
  conversationId?: string;
  /** That conversation is muted: counted and listed, but no native notification. */
  muted?: boolean;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pending: PendingItem[] = [];
// My Mac: the agents' link to this Mac (created once the app is ready; see startMyMac).
let myMac: MyMac | null = null;
let macHost: ReturnType<typeof createMacHost> | null = null;
let myMacState: MyMacLinkState | null = null;
const notifiedIds = new Set<string>();

// --- Packaged asset protocol (AL2) -------------------------------------------
//
// loadFile serves the renderer from file:// with the opaque origin `null`, which the account
// backend rejects with HTTP 403 MISSING_OR_NULL_ORIGIN. The packaged window instead loads
// electron://app/index.html: a standard + secure custom scheme whose origin is already in the
// backend CORS allow-list and the Better Auth trusted origins, so cookie login sends
// `Origin: electron://app`. registerSchemesAsPrivileged must run before `app` is ready
// (module scope); the handler is registered before the production document loads. Dev keeps
// the Vite URL in createWindow. The renderer uses hash routing, so no history fallback is
// needed: every route stays on the document path.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const rendererDirectory = join(desktopMainDirectory, "../renderer");

function registerAssetProtocol(): void {
  protocol.handle(APP_SCHEME, (request) => handleAssetRequest(request.url));
}

async function handleAssetRequest(requestUrl: string): Promise<Response> {
  const resolved = resolveAssetPath(rendererDirectory, requestUrl);
  if (!resolved) return new Response("Not found", { status: 404 });
  try {
    // Lexical confinement cannot see through symlinks, so re-check after
    // resolving every link. realpath works on packaged asar paths and a
    // missing file throws below into the same 404.
    const rootReal = await realpath(rendererDirectory);
    const fileReal = await realpath(resolved);
    if (!isAssetPathConfined(rootReal, fileReal)) return new Response("Not found", { status: 404 });
    const body = await readFile(fileReal);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": mimeForPath(resolved),
        "Content-Security-Policy": contentSecurityPolicy(),
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

// --- Content Security Policy -------------------------------------------------

function contentSecurityPolicy(): string {
  return buildContentSecurityPolicy({
    serverOrigins: [...allowedServerOrigins],
    streamOrigins: STREAM_ORIGINS,
    devOrigins: DEV_ORIGINS,
  });
}

/** Dictation: the renderer may use the microphone, only the app's own page, and never the camera. */
function applyMediaPermissions(): void {
  const own = (url: string): boolean => {
    try {
      const origin = new URL(url).origin;
      return origin === APP_ORIGIN || DEV_ORIGINS.includes(origin);
    } catch {
      return false;
    }
  };
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (permission !== "media") return false;
    return own(requestingOrigin) && (details as { mediaType?: string }).mediaType !== "video";
  });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    if (permission !== "media" || !own(details.requestingUrl) || types.length === 0 || types.includes("video")) {
      callback(false);
      return;
    }
    if (process.platform !== "darwin") {
      callback(true);
      return;
    }
    // macOS asks for the app's microphone access itself the first time.
    void systemPreferences.askForMediaAccess("microphone").then(callback, () => callback(false));
  });
}

function applyCsp(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy()],
      },
    });
  });
}

// --- Allowed server origin (persisted) ---------------------------------------

// The user's chosen server origin, so a custom server is still allowed after the app reloads or
// restarts. Only the origin is stored — never the token.
function serverOriginPath(): string {
  return join(app.getPath("userData"), "server-origin.json");
}

function loadPersistedServerOrigin(): string | null {
  try {
    if (!existsSync(serverOriginPath())) return null;
    const parsed: unknown = JSON.parse(readFileSync(serverOriginPath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    if (!("origin" in parsed) || typeof parsed.origin !== "string") return null;
    return normalizeServerOrigin(parsed.origin);
  } catch {
    return null;
  }
}

function persistServerOrigin(origin: string): void {
  try {
    const path = serverOriginPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ origin }, null, 2), { mode: 0o600 });
  } catch {
    /* best effort: an unwritable store must never block connecting */
  }
}

// --- Window ------------------------------------------------------------------

function windowMetrics() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const large = width >= 1600;
  return {
    width: large ? 1440 : 1040,
    height: large ? 960 : 760,
    minWidth: 512,
    minHeight: 520,
  };
}

let openedHidden = process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAsHidden;

function createWindow(): BrowserWindow {
  const { width, height, minWidth, minHeight } = windowMetrics();
  const dark = nativeTheme.shouldUseDarkColors;

  const win = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    show: false,
    // macOS: the window is a native vibrancy material, so its background must be clear for
    // the chrome to show the desktop through it (owner reference 2026-10-17). Windows keeps
    // an opaque canvas.
    backgroundColor: process.platform === "darwin" ? "#00000000" : dark ? DEFAULT_BG : "#ffffff",
    // "hidden" rather than "hiddenInset": with native vibrancy the inset title bar sits under
    // the effect view and the traffic lights disappear; "hidden" keeps them above it.
    titleBarStyle: process.platform === "darwin" ? "hidden" : "hidden",
    ...(process.platform === "darwin"
      ? {
          trafficLightPosition: { x: TRAFFIC_LIGHT_POSITION.x, y: TRAFFIC_LIGHT_POSITION.y },
          vibrancy: "sidebar" as const,
          visualEffectState: "active" as const,
        }
      : {
          titleBarOverlay: {
            color: dark ? DEFAULT_BG : "#ffffff",
            symbolColor: dark ? "#e6e9ef" : "#1b1f27",
            height: SHELL_HEADER_HEIGHT_PX,
          },
        }),
    webPreferences: {
      preload: join(desktopMainDirectory, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  // Opened at login (Settings > Launch at login): stay in the tray; the engine and sandbox are ready when the user opens Juno.
  const hidden = openedHidden;
  openedHidden = false;
  observeStartup(win, hidden);

  // Mirror maximize state to the renderer so its title-bar button can flip.
  win.on("maximize", () => win.webContents.send("platform:window:maximize-change", true));
  win.on("unmaximize", () => win.webContents.send("platform:window:maximize-change", false));

  // The Computer pane's "Separate window" pop-out: open an app window instead of a browser tab.
  win.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      width: 1040,
      height: 760,
      backgroundColor: dark ? DEFAULT_BG : "#ffffff",
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(desktopMainDirectory, "../preload/index.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    },
  }));

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL).catch(() => reportStartupFailure(win, "load-rejected"));
  } else {
    // Served from the privileged electron://app origin above, never the file scheme: the
    // document needs the non-opaque origin the backend trusts for cookie auth.
    void win.loadURL(APP_URL).catch(() => reportStartupFailure(win, "load-rejected"));
  }

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  return win;
}

/** Show the window (recreating it if the user closed it) and focus it. */
function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  revealWindow(mainWindow);
}

// --- Tray + notifications ----------------------------------------------------

function trayImage(): Electron.NativeImage {
  const image = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, "base64"), { scaleFactor: 2 });
  image.setTemplateImage(true);
  return image;
}

/** Tray / notification "Open": bring the window forward and let the renderer open the request's conversation. */
function openRequest(item: PendingItem): void {
  showWindow();
  mainWindow?.webContents.send("platform:action", {
    type: "open-request",
    id: item.id,
    ...(item.conversationId ? { conversationId: item.conversationId } : {}),
  });
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: pending.length > 0 ? `${pending.length} waiting on you` : "No pending requests", enabled: false },
    { type: "separator" },
  ];
  for (const item of pending.slice(0, 5)) {
    items.push({
      label: item.agentName ? `${item.agentName} · ${item.title}` : item.title,
      click: () => openRequest(item),
    });
  }
  if (pending.length > 5) items.push({ label: `+${pending.length - 5} more…`, enabled: false });
  items.push(...myMacTrayItems());
  items.push(
    { type: "separator" },
    { label: "Open Juno", click: () => showWindow() },
    { label: "Quit", click: () => { app.quit(); } },
  );

  tray.setToolTip(pending.length > 0 ? `Juno · ${pending.length} waiting` : "Juno");
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

/** While an agent runs a command on this Mac the menu bar says so, with the Stop that cancels it and holds everything until resumed. */
function myMacTrayItems(): Electron.MenuItemConstructorOptions[] {
  if (!myMacState?.paired) return [];
  if (myMacState.stopped) {
    return [{ type: "separator" }, { label: "Agents are stopped on this Mac", enabled: false }, { label: "Resume", click: () => setMacStopped(false) }];
  }
  if (myMacState.running > 0) {
    const command = (myMacState.command ?? "").slice(0, 60);
    return [{ type: "separator" }, { label: command === "" ? "An agent is using this Mac" : `An agent is running: ${command}`, enabled: false }, { label: "Stop", click: () => setMacStopped(true) }];
  }
  return [];
}

function applyMyMacState(next: MyMacLinkState): void {
  myMacState = next;
  if (process.platform === "darwin") tray?.setTitle(next.paired && next.stopped ? " Stopped" : next.paired && next.running > 0 ? " Running" : "");
  rebuildTrayMenu();
  // cua-driver runs once a Mac is paired (idempotent), and stays until the app quits.
  if (next.paired) void macHost?.startDesktop();
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("platform:myMac:state", next);
}

/** Stop cancels what is running and holds new work until Resume. */
function setMacStopped(stopped: boolean): void {
  myMac?.setStopped(stopped);
}

function startMyMac(): void {
  const secrets = {
    get: (key: string) => {
      const stored = readSecrets()[key];
      return stored ? decrypt(stored) : null;
    },
    set: (key: string, value: string) => {
      const store = readSecrets();
      store[key] = encrypt(value);
      writeSecrets(store);
    },
    delete: (key: string) => {
      const store = readSecrets();
      delete store[key];
      writeSecrets(store);
    },
  };
  // The agents' commands inherit this app's environment minus anything Electron or Juno itself set.
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ELECTRON_") && !name.startsWith("AGENT_DESKTOP_")));
  childEnv["PATH"] = commandPath(process.env.PATH);
  const resourcesRoot = app.isPackaged ? process.resourcesPath : join(desktopMainDirectory, "../../vendor");
  macHost = process.platform === "darwin" ? createMacHost({
    userDataDir: app.getPath("userData"),
    ...(process.env.AGENT_DESKTOP_CHROME_HOME ? { chromeHome: process.env.AGENT_DESKTOP_CHROME_HOME } : {}),
    folder: junoFolder(homedir()),
    resourcesRoot,
    ...(process.env.JUNO_CUA_DRIVER ? { cuaBinary: process.env.JUNO_CUA_DRIVER } : {}),
    bundleId: "io.github.nigelleong0703.agent-desktop",
    log: (message) => startupLog(`my-mac: ${message}`),
    onDesktopChange: () => void myMac?.refreshDeclaration().catch(() => undefined),
    extensionPath: app.isPackaged ? join(process.resourcesPath, "chrome-extension") : join(desktopMainDirectory, "../../vendor/chrome-extension"),
    openSettings: (kind) => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${kind === "screen" ? "Privacy_ScreenCapture" : "Privacy_Accessibility"}`),
    showExtension: (path) => shell.showItemInFolder(join(path, "manifest.json")),
    openChromeExtensions: () => new Promise<void>((resolve, reject) => execFile("/usr/bin/open", ["-a", "Google Chrome", "chrome://extensions/"], (error) => error ? reject(error) : resolve())),
  }) : null;
  const host = macHost;
  myMac = createMyMac({
    folder: junoFolder(homedir()),
    scratchDir: join(app.getPath("userData"), "link-scratch"),
    deviceName: hostname().replace(/\.local$/, ""),
    osVersion: `macOS ${process.getSystemVersion()}`,
    secrets,
    childEnv,
    ...(host === null ? {} : { desktop: host, cua: host.cua, abilities: () => host.abilities() }),
    log: (message) => startupLog(`my-mac: ${message}`),
  });
  myMac.onChange(applyMyMacState);
  myMacState = myMac.state();
}

function updateTray(payload: PendingItem[]): void {
  pending = payload;
  app.setBadgeCount(pending.length);
  rebuildTrayMenu();

  if (!Notification.isSupported()) return;
  for (const item of pending) {
    if (notifiedIds.has(item.id)) continue;
    notifiedIds.add(item.id);
    // A muted conversation stays quiet, like its in-app toast (the badge and tray count still show it).
    if (item.muted) continue;
    const notification = new Notification({
      title: item.agentName ? `${item.agentName} needs you` : "Needs you",
      body: item.title,
      actions:
        process.platform === "darwin" ? [{ type: "button", text: "Open" }] : undefined,
      silent: false,
    });
    notification.on("click", () => openRequest(item));
    notification.on("action", () => openRequest(item));
    notification.show();
  }
  // Forget ids that are no longer pending so a later re-request can notify again.
  for (const id of [...notifiedIds]) {
    if (!pending.some((item) => item.id === id)) notifiedIds.delete(id);
  }
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.on("click", () => showWindow());
  rebuildTrayMenu();
}

// --- Secrets (safeStorage) ---------------------------------------------------

function secretsPath(): string {
  return join(app.getPath("userData"), "secrets.json");
}

function readSecrets(): Record<string, string> {
  try {
    if (!existsSync(secretsPath())) return {};
    return JSON.parse(readFileSync(secretsPath(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSecrets(store: Record<string, string>): void {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store), { mode: 0o600 });
}

function encrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString("base64");
  }
  // Fall back to plaintext only when the OS keyring is unavailable (e.g. some Linux CI boxes).
  return `plain:${Buffer.from(value, "utf8").toString("base64")}`;
}

function decrypt(stored: string): string | null {
  try {
    if (stored.startsWith("plain:")) {
      return Buffer.from(stored.slice("plain:".length), "base64").toString("utf8");
    }
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return null;
  }
}

// --- Deep links --------------------------------------------------------------

function handleDeepLink(url: string): void {
  if (!url.startsWith(`${APP_PROTOCOL}://`)) return;
  showWindow();
  mainWindow?.webContents.send("platform:action", { type: "deep-link", url });
}

function registerProtocol(): void {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [fileURLToPath(import.meta.url)]);
    }
  } else {
    app.setAsDefaultProtocolClient(APP_PROTOCOL);
  }
}

// --- IPC ---------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.on("startup:status", (_event, status: unknown) => {
    if (status === "preload-ready" || status === "renderer-ready" || status === "renderer-error") startupLog(status);
  });
  ipcMain.on("platform:window", (_event, action: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    if (!win) return;
    if (action === "minimize") win.minimize();
    else if (action === "toggleMaximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
    else if (action === "close") win.close();
  });

  ipcMain.handle("platform:window:isMaximized", () => mainWindow?.isMaximized() ?? false);

  ipcMain.on("platform:notify", (_event, options: { title: string; body?: string }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: options.title, body: options.body });
    notification.on("click", () => showWindow());
    notification.show();
  });

  ipcMain.on("platform:badge", (_event, count: number) => app.setBadgeCount(count));
  // The app's theme drives the native appearance too: vibrancy materials and the window
  // chrome must follow it, not the macOS system setting (a light material behind a dark
  // theme renders the chrome as washed-out grey).
  ipcMain.on("platform:appearance", (_event, appearance: unknown) => {
    if (appearance === "dark" || appearance === "light" || appearance === "system") {
      nativeTheme.themeSource = appearance;
    }
  });

  ipcMain.on("platform:openExternal", (_event, url: string) => {
    if (typeof url === "string" && /^https?:/.test(url)) void shell.openExternal(url);
  });

  ipcMain.on("platform:pending", (_event, items: PendingItem[]) => updateTray(items ?? []));

  ipcMain.handle("platform:secrets:get", (_event, key: string) => {
    const stored = readSecrets()[key];
    return stored ? decrypt(stored) : null;
  });
  ipcMain.handle("platform:secrets:set", (_event, key: string, value: string) => {
    const store = readSecrets();
    store[key] = encrypt(value);
    writeSecrets(store);
  });
  ipcMain.handle("platform:secrets:delete", (_event, key: string) => {
    const store = readSecrets();
    delete store[key];
    writeSecrets(store);
  });

  ipcMain.handle("platform:loginItem:get", () => app.getLoginItemSettings().openAtLogin);

  // My Mac: the renderer pairs through the server (it holds the session) and hands the pairing over; only a websocket address
  // and plain strings are accepted, and the token goes straight into the Keychain-backed store.
  ipcMain.handle("platform:myMac:state", () => myMac?.state() ?? null);
  ipcMain.handle("platform:myMac:connect", async (_event, value: unknown) => {
    const pairing = parsePairing(value);
    if (!pairing || !myMac) throw new Error("invalid pairing");
    await myMac.connect(pairing);
  });
  ipcMain.handle("platform:myMac:disconnect", () => myMac?.disconnect());
  ipcMain.on("platform:myMac:stopped", (_event, stopped: unknown) => setMacStopped(stopped === true));
  // The settings page asks for the desktop state while the user grants permissions: a grant it sees is declared to the server at once.
  ipcMain.handle("platform:myMac:desktop", async () => {
    const state = await macHost?.status();
    void myMac?.refreshDeclaration().catch(() => undefined);
    return state;
  });
  ipcMain.handle("platform:myMac:permission", async (_event, kind: unknown) => {
    if (kind !== "screen" && kind !== "accessibility") throw new Error("invalid Mac permission");
    if (!macHost) throw new Error("Mac desktop actions are unavailable on this platform");
    await macHost.requestPermission(kind);
  });
  ipcMain.handle("platform:myMac:chrome-setup", async () => {
    if (!macHost) throw new Error("Mac Chrome is unavailable on this platform");
    await macHost.setupChrome();
    void myMac?.refreshDeclaration().catch(() => undefined);
  });

  // The renderer registers the server it is about to use *before* it makes any request. The value
  // is validated here; a new origin widens the CSP and is persisted. A document's CSP is fixed once
  // it has loaded, so the renderer — told `changed: true` — reloads and re-bootstraps under the
  // fresh policy rather than fetching against the stale one.
  ipcMain.handle("platform:server:allow-origin", (_event, value: unknown) => {
    const { origin, changed } = registerServerOrigin(allowedServerOrigins, value);
    if (!origin) return null;
    allowedServerOrigins.add(origin);
    if (changed) persistServerOrigin(origin);
    return { origin, reloadRequired: changed };
  });

  ipcMain.handle("platform:loginItem:set", (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return app.getLoginItemSettings().openAtLogin;
  });
}

// --- Updater -----------------------------------------------------------------

function wireUpdater(): void {
  // Packaged builds read their feed from app-update.yml (electron-builder `publish`: the GitHub releases of juno-releases).
  if (!app.isPackaged && !process.env.AGENT_DESKTOP_UPDATE_URL) return;
  try {
    // Beta releases are GitHub pre-releases; download in the background, install when the app quits or the user restarts.
    autoUpdater.allowPrerelease = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-available", () => {
      mainWindow?.webContents.send("platform:action", { type: "update-available" });
    });
    autoUpdater.on("update-downloaded", (info) => {
      const options = {
        type: "info" as const,
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: `Juno ${info.version} is ready`,
        detail: "Restart Juno to finish updating. Otherwise it updates the next time you quit.",
      };
      const shown = mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
      void shown.then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
    });
    const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
    check();
    setInterval(check, 4 * 60 * 60 * 1000).unref();
  } catch {
    /* updater is best-effort; a missing feed must never crash startup */
  }
}

// --- Lifecycle ---------------------------------------------------------------

process.on("uncaughtException", () => reportStartupFailure(mainWindow, "main-uncaught-exception"));
process.on("unhandledRejection", () => reportStartupFailure(mainWindow, "main-unhandled-rejection"));
startupLog("main-entry");
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  startupLog("single-instance-forwarded");
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith(`${APP_PROTOCOL}://`));
    if (url) handleDeepLink(url);
    else showWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  void app.whenReady().then(() => {
    startupLog("app-ready");
    const persistedOrigin = loadPersistedServerOrigin();
    if (persistedOrigin) allowedServerOrigins.add(persistedOrigin);
    registerProtocol();
    applyCsp();
    applyMediaPermissions();
    startMyMac();
    registerIpc();
    registerAssetProtocol();
    // Explicit brand menu for fresh and migrated bundles, preserving all standard menu roles.
    if (process.platform === "darwin") {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { label: "Juno", role: "appMenu" },
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
        { role: "help", submenu: [{ role: "about" }] },
      ]));
    }
    mainWindow = createWindow();
    createTray();
    // The saved pairing (if any) comes back up.
    void myMac?.restore().catch(() => undefined);
    wireUpdater();

    app.on("activate", () => {
      showWindow();
    });
  });

  // Keep running when the window is closed: the app lives in the tray.
  app.on("window-all-closed", () => {
    // Intentionally no quit (VISUAL.md: the app keeps running for notifications).
  });

  // cua-driver is stopped (and its socket removed) before the app exits; the quit is held until that is done.
  let desktopStopped = false;
  app.on("before-quit", (event) => {
    if (macHost && !desktopStopped) {
      event.preventDefault();
      desktopStopped = true;
      myMac?.suspend();
      void macHost.dispose().catch(() => undefined).finally(() => app.quit());
      return;
    }
    tray?.destroy();
    tray = null;
  });
}
