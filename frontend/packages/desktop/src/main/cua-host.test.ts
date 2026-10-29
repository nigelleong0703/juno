import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCuaHost, type CuaHost } from "./cua-host";

// A stand-in for the cua-driver executable: `serve` opens the socket it is given, `call` answers check_permissions.
const FAKE = `#!/usr/bin/env node
import net from "node:net";
import fs from "node:fs";
const [command, ...rest] = process.argv.slice(2);
if (command === "serve") {
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ pid: process.pid, args: rest, embedded: process.env.CUA_DRIVER_EMBEDDED, bundle: process.env.CUA_DRIVER_HOST_BUNDLE_ID, electron: process.env.ELECTRON_RUN_AS_NODE }) + "\\n");
  net.createServer().listen(rest[rest.indexOf("--socket") + 1]);
  process.on("SIGTERM", () => process.exit(0));
} else if (command === "call") {
  process.stdout.write(JSON.stringify({ accessibility: true, screen_recording: false, source: { attribution: "host" } }));
}
`;

let root: string;
let binary: string;
const hosts: CuaHost[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "juno-cua-host-test-"));
  binary = join(root, "cua-driver");
  writeFileSync(binary, FAKE);
  chmodSync(binary, 0o755);
  process.env["FAKE_LOG"] = join(root, "serve.jsonl");
  process.env["ELECTRON_RUN_AS_NODE"] = "1";
  writeFileSync(process.env["FAKE_LOG"], "");
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
  delete process.env["ELECTRON_RUN_AS_NODE"];
  rmSync(root, { recursive: true, force: true });
});

const launches = () => readFileSync(join(root, "serve.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pid: number; args: string[]; embedded: string; bundle: string; electron?: string });

function host(onChange = vi.fn()) {
  const created = createCuaHost({ binaryPath: binary, hostBundleId: "dev.test.juno", log: vi.fn(), onChange });
  hosts.push(created);
  return { host: created, onChange };
}

describe("cua-driver host", () => {
  it("starts the daemon embedded in Juno's chain with a private socket, and reads Juno's grants from it", async () => {
    const { host: cua, onChange } = host();
    expect(cua.running()).toBe(false);
    await cua.start();
    expect(cua.running()).toBe(true);
    expect(onChange).toHaveBeenCalledOnce();
    const [launch] = launches();
    expect(launch).toMatchObject({ embedded: "1", bundle: "dev.test.juno" });
    expect(launch?.args.slice(0, 2)).toEqual(["--embedded", "--socket"]);
    expect(launch?.electron).toBeUndefined();
    expect(await cua.permissions()).toEqual({ screen: false, accessibility: true, host: true });
  });

  it("restarts it when it dies, but not after the app asked it to stop", async () => {
    const { host: cua } = host();
    await cua.start();
    const first = launches()[0]?.pid ?? 0;
    process.kill(first, "SIGKILL");
    await vi.waitFor(() => expect(launches()).toHaveLength(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(cua.running()).toBe(true), { timeout: 5_000 });
    expect(launches()[1]?.pid).not.toBe(first);

    await cua.stop();
    expect(cua.running()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(launches()).toHaveLength(2);
  }, 15_000);

  it("replaces the daemon on request so it sees a new grant", async () => {
    const { host: cua } = host();
    await cua.start();
    await cua.restart();
    expect(launches()).toHaveLength(2);
    expect(cua.running()).toBe(true);
  });

  it("says plainly when the binary is not in the build", async () => {
    const missing = createCuaHost({ binaryPath: join(root, "nope"), hostBundleId: "dev.test.juno", log: vi.fn(), onChange: vi.fn() });
    hosts.push(missing);
    await expect(missing.start()).rejects.toThrow(/missing/u);
  });
});
