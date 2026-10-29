import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, dialog: {} }));
import { revealWindow } from "./startup";

describe("window recovery", () => {
  it("reveals and focuses a hidden existing window", () => {
    const show = vi.fn();
    const focus = vi.fn();
    revealWindow({ isDestroyed: () => false, isMinimized: () => false, restore: vi.fn(), show, focus });
    expect(show).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });
  it("restores a minimized window and ignores destroyed windows", () => {
    const restore = vi.fn();
    const show = vi.fn();
    const focus = vi.fn();
    revealWindow({ isDestroyed: () => false, isMinimized: () => true, restore, show, focus });
    expect(restore).toHaveBeenCalledOnce();
    revealWindow({ isDestroyed: () => true, isMinimized: () => true, restore, show, focus });
    expect(show).toHaveBeenCalledOnce();
  });
  it("preserves Electron runtime imports in both built entry points", () => {
    const preload = readFileSync("out/preload/index.cjs", "utf8");
    const main = readFileSync("out/main/index.js", "utf8");
    // Released builds are minified (`from"electron"`), so match with or without spaces.
    expect(preload).toMatch(/require\(\s*["']electron["']\s*\)/);
    expect(main).toMatch(/from\s*["']electron["']/);
    expect(preload).not.toContain("getElectronPath");
    expect(main).not.toContain("getElectronPath");
    expect(main).toMatch(/from\s*["']electron-updater["']/);
    expect(main).not.toMatch(/import\s*\{[^}]*autoUpdater[^}]*\}\s*from\s*["']electron-updater/);
    // Catch build-generated shims colliding with source declarations before Electron opens a modal.
    expect(() => execFileSync(process.execPath, ["--check", "out/main/index.js"])).not.toThrow();
    expect(() => execFileSync(process.execPath, ["--check", "out/preload/index.cjs"])).not.toThrow();
    expect(main).not.toContain("Electron failed to install correctly");
    expect(preload).not.toContain("Electron failed to install correctly");
    expect(preload).not.toContain('require("fs")');
    const html = readFileSync("out/renderer/index.html", "utf8");
    expect(html).toContain("startup.js");
    expect(html).toContain("Starting Juno");
    expect(html).not.toContain('http-equiv="Content-Security-Policy"');
    expect(readFileSync("out/renderer/startup.js", "utf8")).toContain("renderer-error");
  });
});
