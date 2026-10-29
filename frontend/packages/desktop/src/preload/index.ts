import type {
  MyMacLinkState,
  MyMacDesktopState,
  PlatformAdapter,
  PlatformMyMac,
  PlatformLoginItem,
  PlatformNotifyOptions,
  PlatformSecretStore,
  PlatformWindowControls,
} from "@agent-desktop/app";
import { contextBridge, ipcRenderer } from "electron";
import { requireAllowedServerOrigin } from "../main/server-origin";

/**
 * The preload bridge (E2 · ARCHITECTURE §9). It is the only place the renderer can reach the OS:
 * a typed `window.platform` implementing the `PlatformAdapter` contract owned by `packages/app`.
 * No Node APIs are exposed — the renderer stays sandboxed with context isolation.
 *
 * Built as CommonJS (`index.cjs`) because sandboxed preloads cannot be ES modules.
 */

export interface DesktopActionEvent {
  type: "open-request" | "deep-link" | "update-available";
  id?: string;
  conversationId?: string;
  url?: string;
}

const secrets: PlatformSecretStore = {
  get: (key) => ipcRenderer.invoke("platform:secrets:get", key) as Promise<string | null>,
  set: (key, value) => ipcRenderer.invoke("platform:secrets:set", key, value) as Promise<void>,
  delete: (key) => ipcRenderer.invoke("platform:secrets:delete", key) as Promise<void>,
};

const windowControls: PlatformWindowControls = {
  minimize: () => ipcRenderer.send("platform:window", "minimize"),
  toggleMaximize: () => ipcRenderer.send("platform:window", "toggleMaximize"),
  close: () => ipcRenderer.send("platform:window", "close"),
  isMaximized: () => ipcRenderer.invoke("platform:window:isMaximized") as Promise<boolean>,
  onMaximizeChange: (listener) => {
    const handler = (_event: unknown, maximized: boolean) => listener(maximized);
    ipcRenderer.on("platform:window:maximize-change", handler);
    return () => ipcRenderer.removeListener("platform:window:maximize-change", handler);
  },
};

const launchAtLogin: PlatformLoginItem = {
  get: () => ipcRenderer.invoke("platform:loginItem:get") as Promise<boolean>,
  set: (enabled) => ipcRenderer.invoke("platform:loginItem:set", enabled) as Promise<boolean>,
};

const myMac: PlatformMyMac = {
  desktopStatus: () => ipcRenderer.invoke("platform:myMac:desktop") as Promise<MyMacDesktopState>,
  requestPermission: (kind) => ipcRenderer.invoke("platform:myMac:permission", kind) as Promise<void>,
  setupChrome: () => ipcRenderer.invoke("platform:myMac:chrome-setup") as Promise<void>,
  state: () => ipcRenderer.invoke("platform:myMac:state") as Promise<MyMacLinkState>,
  onState: (listener) => {
    const handler = (_event: unknown, next: MyMacLinkState) => listener(next);
    ipcRenderer.on("platform:myMac:state", handler);
    return () => ipcRenderer.removeListener("platform:myMac:state", handler);
  },
  connect: (pairing) => ipcRenderer.invoke("platform:myMac:connect", pairing) as Promise<void>,
  disconnect: () => ipcRenderer.invoke("platform:myMac:disconnect") as Promise<void>,
  setStopped: (stopped) => ipcRenderer.send("platform:myMac:stopped", stopped),
};

const platform: PlatformAdapter = {
  id: process.platform,
  isDesktop: true,
  hasTrafficLights: process.platform === "darwin",
  notify(options: PlatformNotifyOptions) {
    ipcRenderer.send("platform:notify", { title: options.title, body: options.body });
  },
  openExternal(url: string) {
    ipcRenderer.send("platform:openExternal", url);
  },
  setBadge(count: number) {
    ipcRenderer.send("platform:badge", count);
  },
  setAppearance(appearance: "dark" | "light" | "system") {
    ipcRenderer.send("platform:appearance", appearance);
  },
  async allowServerOrigin(url: string) {
    const result = await ipcRenderer.invoke("platform:server:allow-origin", url);
    return requireAllowedServerOrigin(result);
  },
  secrets,
  window: windowControls,
  launchAtLogin,
  myMac,
  requestNotificationPermission: async () => true,
};

/** Subscribe to tray / notification / deep-link actions from the main process. */
function onAction(listener: (event: DesktopActionEvent) => void): () => void {
  const handler = (_event: unknown, payload: DesktopActionEvent) => listener(payload);
  ipcRenderer.on("platform:action", handler);
  return () => ipcRenderer.removeListener("platform:action", handler);
}

/** Publish the current pending-approval list so main can badge the dock and build the tray menu. */
function setPending(items: Array<{ id: string; title: string; agentName?: string; conversationId?: string; muted?: boolean }>): void {
  ipcRenderer.send("platform:pending", items);
}

contextBridge.exposeInMainWorld("startup", {
  report(status: string) {
    if (status === "renderer-ready" || status === "renderer-error") ipcRenderer.send("startup:status", status);
  },
});
ipcRenderer.send("startup:status", "preload-ready");
contextBridge.exposeInMainWorld("platform", platform);
contextBridge.exposeInMainWorld("desktop", { onAction, setPending });
