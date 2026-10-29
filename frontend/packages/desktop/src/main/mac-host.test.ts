import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMacHost } from "./mac-host";

const doubles = vi.hoisted(() => ({
  native: { handle: vi.fn(), stop: vi.fn() },
  chrome: { browser: vi.fn(), setup: vi.fn(), connected: vi.fn(), stop: vi.fn() },
  cua: { client: { call: vi.fn() }, running: vi.fn(), start: vi.fn(), permissions: vi.fn(), restart: vi.fn(), stop: vi.fn() },
}));
vi.mock("./mac-desktop", () => ({ createMacDesktop: () => doubles.native }));
vi.mock("./chrome-bridge", () => ({ createChromeBridge: () => doubles.chrome }));
vi.mock("./cua-host", () => ({ createCuaHost: () => doubles.cua }));

function setup() {
  const openSettings = vi.fn(async () => undefined);
  const showExtension = vi.fn();
  const openChromeExtensions = vi.fn(async () => undefined);
  const host = createMacHost({
    userDataDir: "/tmp/juno-test", folder: "/tmp/Juno", resourcesRoot: "/tmp/vendor", extensionPath: "/tmp/extension", bundleId: "dev.test.juno",
    log: vi.fn(), onDesktopChange: vi.fn(), openSettings, showExtension, openChromeExtensions,
  });
  return { host, openSettings, showExtension, openChromeExtensions };
}

const GRANTED = { screen: true, accessibility: true, audio: true };

beforeEach(() => {
  vi.clearAllMocks();
  doubles.chrome.setup.mockResolvedValue(undefined);
  doubles.chrome.connected.mockReturnValue(false);
  doubles.native.handle.mockResolvedValue({ screen: false, accessibility: false, audio: false });
  doubles.cua.running.mockReturnValue(true);
  doubles.cua.restart.mockResolvedValue(undefined);
  doubles.cua.stop.mockResolvedValue(undefined);
  doubles.cua.permissions.mockResolvedValue({ screen: true, accessibility: true, host: true });
});

describe("Mac host owner boundary", () => {
  it("remote work cannot prompt for permissions", async () => {
    const { host } = setup();
    const signal = new AbortController().signal;
    await host.handle({ agentId: "agent-a", action: "permissions", input: { request: "accessibility" } }, signal);
    expect(doubles.native.handle).toHaveBeenLastCalledWith({ agentId: "agent-a", action: "permissions", input: {} }, signal);
  });

  it("owner-initiated permission setup reaches the helper, while failures are visible", async () => {
    const { host, openSettings } = setup();
    await host.requestPermission("screen");
    expect(doubles.native.handle).toHaveBeenLastCalledWith({ agentId: "owner", action: "permissions", input: { request: "screen" } }, expect.any(AbortSignal));
    expect(openSettings).toHaveBeenCalledWith("screen");
    doubles.native.handle.mockRejectedValueOnce(new Error("Mac helper is missing; update Juno"));
    expect(await host.status()).toMatchObject({ screen: false, accessibility: false, audio: false, detail: "Mac helper is missing; update Juno" });
  });

  it("stopping work leaves the bridge available for resume, while app quit closes it and cua-driver", async () => {
    const { host } = setup();
    host.stop();
    expect(doubles.native.stop).toHaveBeenCalledOnce();
    expect(doubles.chrome.stop).not.toHaveBeenCalled();
    expect(doubles.cua.stop).not.toHaveBeenCalled();
    await host.dispose();
    expect(doubles.chrome.stop).toHaveBeenCalledOnce();
    expect(doubles.cua.stop).toHaveBeenCalledOnce();
  });
});

describe("Mac host desktop ability", () => {
  it("declares desktop only while cua-driver runs with both of Juno's grants", async () => {
    const { host } = setup();
    doubles.native.handle.mockResolvedValue(GRANTED);
    expect(await host.abilities()).toEqual({ desktop: true, audio: true, chrome: false });

    doubles.native.handle.mockResolvedValue({ ...GRANTED, accessibility: false });
    expect(await host.abilities()).toMatchObject({ desktop: false });

    doubles.native.handle.mockResolvedValue(GRANTED);
    doubles.cua.running.mockReturnValue(false);
    expect(await host.abilities()).toMatchObject({ desktop: false });
    expect(await host.status()).toMatchObject({ screen: true, accessibility: true, detail: expect.stringMatching(/not running/u) });

    doubles.cua.running.mockReturnValue(true);
    doubles.cua.permissions.mockResolvedValue({ screen: true, accessibility: true, host: false });
    expect(await host.abilities()).toMatchObject({ desktop: false });
    expect(await host.status()).toMatchObject({ detail: expect.stringMatching(/Juno's permissions/u) });
  });

  it("replaces a cua-driver that started before the grant, once", async () => {
    const { host } = setup();
    doubles.native.handle.mockResolvedValue(GRANTED);
    doubles.cua.permissions.mockResolvedValue({ screen: false, accessibility: false, host: true });
    expect(await host.abilities()).toMatchObject({ desktop: false });
    expect(await host.abilities()).toMatchObject({ desktop: false });
    expect(doubles.cua.restart).toHaveBeenCalledOnce();

    // The grant going away and coming back is a new grant.
    doubles.native.handle.mockResolvedValue({ ...GRANTED, screen: false });
    await host.abilities();
    doubles.native.handle.mockResolvedValue(GRANTED);
    await host.abilities();
    expect(doubles.cua.restart).toHaveBeenCalledTimes(2);
  });
});
