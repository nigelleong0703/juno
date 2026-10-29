import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServerSettings, setServerSettings } from "../settingsStore";

// Node 26 leaves window.localStorage unavailable under jsdom; back it with an in-memory store.
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("server settings store", () => {
  it("ignores a stale legacy demo flag and never exposes a mock mode", () => {
    // The removed demo path keyed off this legacy localStorage flag; a real client must ignore it.
    window.localStorage.setItem("agent-desktop-use-mock", "true");
    const settings = getServerSettings();
    expect(settings).toEqual({ serverUrl: "http://127.0.0.1:8787", apiToken: "dev-token" });
    expect("useMock" in settings).toBe(false);
  });

  it("persists only the server URL and token", () => {
    setServerSettings({ serverUrl: "https://box.example", apiToken: "s3cret" });
    expect(getServerSettings()).toEqual({ serverUrl: "https://box.example", apiToken: "s3cret" });
    expect(window.localStorage.getItem("agent-desktop-use-mock")).toBeNull();
    expect(window.localStorage.length).toBe(2);
  });
});
