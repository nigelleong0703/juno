import { app, dialog, type BrowserWindow } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Fixed event names and numeric codes only: never persist renderer messages, URLs or tokens. */
export function startupLog(event: string, code?: number): void {
  const record = JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, code });
  process.stdout.write(record + "\n");
  try {
    const directory = app.getPath("logs");
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "startup.log"), record + "\n", { mode: 0o600 });
  } catch { /* stdout remains available before app readiness */ }
}

export interface RecoverableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export function revealWindow(win: RecoverableWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

export function reportStartupFailure(win: BrowserWindow | null, event: string): void {
  startupLog(event);
  if (win && !win.isDestroyed()) revealWindow(win);
  void dialog.showMessageBox({
    type: "error",
    title: "Juno could not start",
    message: "The app could not load. Please reopen it.",
    detail: "Startup diagnostics were saved to the application logs. Your settings have been preserved.",
  });
}

/** `hidden`: Juno was opened at login to sit in the tray, so the window stays hidden until the user opens it. */
export function observeStartup(win: BrowserWindow, hidden = false): void {
  startupLog("window-created");
  win.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (!mainFrame || code === -3) return;
    startupLog("did-fail-load", code);
    reportStartupFailure(win, "load-failed");
  });
  win.webContents.on("preload-error", () => reportStartupFailure(win, "preload-error"));
  win.webContents.on("render-process-gone", () => reportStartupFailure(win, "render-process-gone"));
  win.webContents.on("console-message", (_event, level) => {
    if (level === 3) startupLog("renderer-console-error");
  });
  win.webContents.on("did-finish-load", () => {
    startupLog("did-finish-load");
    void win.webContents.executeJavaScript('Boolean(window.platform && window.startup)').then((ready: unknown) => {
      startupLog(ready === true ? "bridge-verified" : "bridge-missing");
      if (ready !== true) reportStartupFailure(win, "bridge-failed");
    }).catch(() => reportStartupFailure(win, "readiness-probe-failed"));
  });
  win.on("show", () => startupLog("window-visible"));
  win.once("ready-to-show", () => {
    startupLog("ready-to-show");
    if (!hidden) revealWindow(win);
  });
  // Even failed rendering must not leave a permanently invisible window.
  const timer = setTimeout(() => {
    if (!hidden && !win.isDestroyed() && !win.isVisible()) {
      startupLog("visibility-timeout");
      revealWindow(win);
    }
  }, 8_000);
  win.once("closed", () => clearTimeout(timer));
}
