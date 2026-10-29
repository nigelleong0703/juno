import { describe, expect, it, vi } from "vitest";
import { createWebPlatform } from "../adapter";
import {
  createServerConnectivityResolver,
  prepareServerConnectivity,
  resolveServerConnectivity,
} from "../connectivity";
import type { PlatformAdapter, ServerOriginAllowance } from "../adapter";

function platformWith(
  allowServerOrigin: PlatformAdapter["allowServerOrigin"],
): PlatformAdapter {
  return { ...createWebPlatform(), allowServerOrigin };
}

const allowance: ServerOriginAllowance = {
  origin: "https://box.example:9000",
  reloadRequired: true,
};

describe("prepareServerConnectivity", () => {
  it("awaits the shell allowance and passes the typed result through", async () => {
    const events: string[] = [];
    const platform = platformWith(async (url) => {
      events.push(`allow:${url}`);
      return allowance;
    });

    const result = await prepareServerConnectivity(
      { serverUrl: "https://box.example:9000" },
      platform,
    );
    events.push("resolved");

    expect(result).toEqual(allowance);
    expect(events).toEqual(["allow:https://box.example:9000", "resolved"]);
  });

  it("is a no-op on the web adapter", async () => {
    const web = createWebPlatform();
    await expect(
      prepareServerConnectivity({ serverUrl: "https://box.example" }, web),
    ).resolves.toBeNull();
  });
});

describe("resolveServerConnectivity", () => {
  it("asks for a reload when the shell had to add the origin", async () => {
    const platform = platformWith(async () => allowance);
    await expect(
      resolveServerConnectivity(
        { serverUrl: "https://box.example:9000" },
        platform,
      ),
    ).resolves.toEqual({ kind: "reload" });
  });

  it("is ready without a reload when the origin was already allowed", async () => {
    const platform = platformWith(async () => ({
      origin: "http://127.0.0.1:8787",
      reloadRequired: false,
    }));
    await expect(
      resolveServerConnectivity(
        { serverUrl: "http://127.0.0.1:8787" },
        platform,
      ),
    ).resolves.toEqual({ kind: "ready" });
  });

  it("is ready on the web adapter", async () => {
    const web = createWebPlatform();
    await expect(
      resolveServerConnectivity({ serverUrl: "https://box.example" }, web),
    ).resolves.toEqual({ kind: "ready" });
  });

  it("propagates a shell failure instead of reporting ready", async () => {
    const platform = platformWith(async () => {
      throw new Error("ipc unavailable");
    });
    await expect(
      resolveServerConnectivity({ serverUrl: "https://box.example" }, platform),
    ).rejects.toThrow("ipc unavailable");
  });
});

describe("createServerConnectivityResolver (StrictMode-safe)", () => {
  it("shares one shell registration per document+server, so both effect runs see reload", async () => {
    const allow = vi.fn<NonNullable<PlatformAdapter["allowServerOrigin"]>>(async () => allowance);
    const resolve = createServerConnectivityResolver(platformWith(allow));
    const target = { serverUrl: "https://box.example:9000" };

    // StrictMode runs the bootstrap effect twice; both calls happen before any reload.
    const [first, second] = await Promise.all([resolve(target), resolve(target)]);

    expect(allow).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ kind: "reload" });
    expect(second).toEqual({ kind: "reload" });
  });

  it("re-registers when the chosen server changes", async () => {
    const allow = vi.fn<NonNullable<PlatformAdapter["allowServerOrigin"]>>(async (url: string) => ({
      origin: url,
      reloadRequired: false,
    }));
    const resolve = createServerConnectivityResolver(platformWith(allow));

    await resolve({ serverUrl: "https://a.example" });
    await resolve({ serverUrl: "https://b.example" });

    expect(allow).toHaveBeenCalledTimes(2);
  });

  it("always registers a real server with the shell instead of short-circuiting", async () => {
    const allow = vi.fn<NonNullable<PlatformAdapter["allowServerOrigin"]>>(async (url: string) => ({
      origin: url,
      reloadRequired: false,
    }));
    const resolve = createServerConnectivityResolver(platformWith(allow));

    await expect(resolve({ serverUrl: "http://127.0.0.1:8787" })).resolves.toEqual({ kind: "ready" });
    expect(allow).toHaveBeenCalledWith("http://127.0.0.1:8787");
  });

  it("does not cache a rejection, so a retry can re-attempt", async () => {
    const allow = vi.fn<NonNullable<PlatformAdapter["allowServerOrigin"]>>(async () => {
      throw new Error("ipc down");
    });
    const resolve = createServerConnectivityResolver(platformWith(allow));
    const target = { serverUrl: "https://box.example" };

    await expect(resolve(target)).rejects.toThrow("ipc down");
    await expect(resolve(target)).rejects.toThrow("ipc down");

    expect(allow).toHaveBeenCalledTimes(2);
  });
});
