import { describe, expect, it, vi } from "vitest";
import type { DaemonOptions, LinkDaemon } from "juno-link/daemon";
import { commandPath, createMyMac, declaredActions, parsePairing, type MacAbilities } from "./my-mac";

const PAIRING = { id: "mac-0123456789abcdef", url: "ws://localhost:8795/v1/computer-link", token: "t".repeat(64) };
const NOTHING_GRANTED: MacAbilities = { desktop: false, audio: false, chrome: false };

function setup(abilities?: () => Promise<MacAbilities>) {
  const store = new Map<string, string>();
  const daemons: Array<{ options: DaemonOptions; pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; redeclare: ReturnType<typeof vi.fn> }> = [];
  const mac = createMyMac({
    folder: `${process.env["TMPDIR"] ?? "/tmp"}/juno-my-mac-test-${process.pid}`,
    scratchDir: `${process.env["TMPDIR"] ?? "/tmp"}/juno-my-mac-test-scratch-${process.pid}`,
    deviceName: "Test Mac",
    osVersion: "macOS 15.2",
    childEnv: {},
    ...(abilities === undefined ? {} : { abilities }),
    secrets: { get: (key) => store.get(key) ?? null, set: (key, value) => void store.set(key, value), delete: (key) => void store.delete(key) },
    startDaemon: (options): LinkDaemon => {
      const handle = { options, pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), redeclare: vi.fn() };
      daemons.push(handle);
      return { bootId: "boot", pause: handle.pause, resume: handle.resume, activity: () => ({ running: 0, stopped: false }), redeclare: handle.redeclare, stop: handle.stop };
    },
  });
  return { mac, store, daemons };
}

describe("My Mac link", () => {
  it("keeps the pairing in the secret store, limits the daemon to the folder, and comes back after a restart", async () => {
    const { mac, store, daemons } = setup();
    await mac.connect(PAIRING);
    expect(JSON.parse(store.get("my-mac.pairing") ?? "{}")).toEqual(PAIRING);
    expect(daemons[0]?.options.roots).toHaveLength(1);
    expect(daemons[0]?.options.loadConfig()).toEqual(PAIRING);
    expect(mac.state()).toMatchObject({ paired: true, status: "connecting" });

    const again = createMyMac({ folder: "/tmp", scratchDir: "/tmp", deviceName: "x", osVersion: "macOS 15.2", childEnv: {}, secrets: { get: (key) => store.get(key) ?? null, set: () => undefined, delete: () => undefined }, startDaemon: () => ({ bootId: "b", pause() {}, resume() {}, activity: () => ({ running: 0, stopped: false }), redeclare() {}, stop() {} }) });
    await again.restore();
    expect(again.state().paired).toBe(true);
  });

  it("forgets the pairing when the server revokes it or the user disconnects, and relays Stop", async () => {
    const { mac, store, daemons } = setup();
    await mac.connect(PAIRING);
    mac.setStopped(true);
    expect(daemons[0]?.pause).toHaveBeenCalledOnce();
    mac.setStopped(false);
    expect(daemons[0]?.resume).toHaveBeenCalledOnce();

    daemons[0]?.options.onStatus?.("unauthorized");
    await vi.waitFor(() => expect(store.has("my-mac.pairing")).toBe(false));
    expect(mac.state()).toMatchObject({ paired: false, status: "unauthorized" });
    expect(daemons[0]?.stop).toHaveBeenCalled();

    await mac.connect(PAIRING);
    await mac.disconnect();
    expect(store.has("my-mac.pairing")).toBe(false);
    expect(mac.state().paired).toBe(false);
  });

  it("accepts only a websocket address and well-formed strings from the renderer", () => {
    expect(parsePairing(PAIRING)).toEqual(PAIRING);
    expect(parsePairing({ ...PAIRING, url: "https://example.com" })).toBeNull();
    expect(parsePairing({ ...PAIRING, url: "javascript:alert(1)" })).toBeNull();
    expect(parsePairing({ ...PAIRING, token: "short" })).toBeNull();
    expect(parsePairing({ ...PAIRING, id: "../x" })).toBeNull();
    expect(parsePairing(null)).toBeNull();
  });

  it("gives a GUI-launched app the user's command line tools without repeating entries", () => {
    expect(commandPath("/usr/bin:/custom/bin")).toBe("/usr/bin:/custom/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/bin:/usr/sbin:/sbin");
  });
});

describe("My Mac declaration", () => {
  it("declares only files and commands without a desktop host, and adds each ability only once it is granted", () => {
    expect(declaredActions(undefined)).toEqual(["files", "shell"]);
    expect(declaredActions(NOTHING_GRANTED)).toEqual(["files", "shell", "apps"]);
    expect(declaredActions({ desktop: false, audio: false, chrome: true })).toEqual(["files", "shell", "apps", "browser"]);
    expect(declaredActions({ desktop: true, audio: true, chrome: true })).toEqual(["files", "shell", "apps", "desktop", "browser", "audio"]);
  });

  it("declares in the first frame, with a stable device id that survives a restart", async () => {
    const { mac, store, daemons } = setup(async () => NOTHING_GRANTED);
    await mac.connect(PAIRING);
    const first = daemons[0]?.options.device?.();
    expect(first).toMatchObject({ name: "Test Mac", osVersion: "macOS 15.2", actions: ["files", "shell", "apps"] });
    expect(first?.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.get("my-mac.device-id")).toBe(first?.deviceId);

    const again = createMyMac({
      folder: "/tmp", scratchDir: "/tmp", deviceName: "Test Mac", osVersion: "macOS 15.2", childEnv: {}, secrets: { get: (key) => store.get(key) ?? null, set: () => undefined, delete: () => undefined },
      startDaemon: (options) => { daemons.push({ options, pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), redeclare: vi.fn() }); return { bootId: "b", pause() {}, resume() {}, activity: () => ({ running: 0, stopped: false }), redeclare() {}, stop() {} }; },
    });
    await again.restore();
    expect(daemons[1]?.options.device?.().deviceId).toBe(first?.deviceId);
  });

  it("declares a granted permission again on the live link, and only when something changed", async () => {
    let abilities = NOTHING_GRANTED;
    const { mac, daemons } = setup(async () => abilities);
    await mac.connect(PAIRING);
    await mac.refreshDeclaration();
    expect(daemons[0]?.redeclare).not.toHaveBeenCalled();

    abilities = { ...NOTHING_GRANTED, desktop: true };
    await mac.refreshDeclaration();
    expect(daemons[0]?.redeclare).toHaveBeenCalledOnce();
    expect(daemons[0]?.options.device?.().actions).toEqual(["files", "shell", "apps", "desktop"]);

    await mac.refreshDeclaration();
    expect(daemons[0]?.redeclare).toHaveBeenCalledOnce();

    abilities = NOTHING_GRANTED;
    await mac.refreshDeclaration();
    expect(daemons[0]?.redeclare).toHaveBeenCalledTimes(2);
    expect(daemons[0]?.options.device?.().actions).toEqual(["files", "shell", "apps"]);
  });

  it("keeps the saved pairing when declaring fails on restore", async () => {
    const { mac, store, daemons } = setup(async () => { throw new Error("helper missing"); });
    store.set("my-mac.pairing", JSON.stringify(PAIRING));
    await mac.restore();
    expect(store.has("my-mac.pairing")).toBe(true);
    expect(daemons[0]?.options.device?.().actions).toEqual(["files", "shell"]);
  });
});
