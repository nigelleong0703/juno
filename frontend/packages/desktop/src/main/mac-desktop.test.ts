import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMacDesktop, MacDesktopError, type MacDesktop, type MacDesktopOptions } from "./mac-desktop";

const HOSTS: MacDesktop[] = [];
const ROOTS: string[] = [];

afterEach(async () => {
  for (const host of HOSTS.splice(0)) host.stop();
  await Promise.all(ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; helperPath: string; logPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "juno-mac-desktop-test-"));
  ROOTS.push(root);
  const helperPath = join(root, "fake-helper.mjs");
  const logPath = join(root, "requests.jsonl");
  const script = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const logPath = join(root, "requests.jsonl");
const log = (entry) => appendFileSync(logPath, JSON.stringify(entry) + "\\n");
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(body);
  log({ type: "request", pid: process.pid, argv: process.argv.slice(2), request });
  if (request.input.hang === true) {
    process.on("SIGINT", () => log({ type: "ignored", pid: process.pid, signal: "SIGINT", action: request.action }));
    process.on("SIGTERM", () => log({ type: "ignored", pid: process.pid, signal: "SIGTERM", action: request.action }));
    log({ type: "ready", pid: process.pid });
    setInterval(() => {}, 1000);
    return;
  }
  if (request.action === "screenshot") {
    process.stdout.write(JSON.stringify({ data: "ZmFrZS1qcGVn", mimeType: "image/jpeg", width: 1600, height: 1000 }) + "\\n");
    return;
  }
  if (request.action === "permissions") {
    process.stdout.write(JSON.stringify({ screen: true, accessibility: false, audio: true }) + "\\n");
    return;
  }
  if (request.action === "audio_start") {
    const recordingId = "rec-" + request.agentId + (request.input.generation ?? "");
    const path = join(request.input.folder, "Recordings", recordingId + ".caf");
    process.stdout.write(JSON.stringify({ recordingId, path, state: "recording" }) + "\\n");
    const stop = (signal) => {
      log({ type: "signal", pid: process.pid, signal, recordingId, agentId: request.agentId });
      process.stdout.write(JSON.stringify({ recordingId, path, state: "stopped", reason: signal }) + "\\n");
      process.exit(0);
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
});
`;
  await writeFile(helperPath, script, { mode: 0o755 });
  await chmod(helperPath, 0o755);
  return { root, helperPath, logPath };
}

async function log(fixturePath: string): Promise<Array<Record<string, any>>> {
  try {
    const text = await readFile(fixturePath, "utf8");
    return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function client(
  fixturePath: { root: string; helperPath: string },
  browser: MacDesktopOptions["browser"] = vi.fn(async () => ({ ok: true })),
) {
  const desktop = createMacDesktop({ folder: fixturePath.root, helperPath: fixturePath.helperPath, browser });
  HOSTS.push(desktop);
  return { desktop, browser };
}

describe("macOS desktop adapter", () => {
  it("sends exactly one stdin request with no argv", async () => {
    const files = await fixture();
    const { desktop } = client(files);
    const signal = new AbortController().signal;
    await expect(desktop.handle({ agentId: "agent_a", action: "permissions", input: {} }, signal)).resolves.toMatchObject({ screen: true, accessibility: false, audio: true });
    await desktop.handle({ agentId: "agent_a", action: "permissions", input: { request: "screen" } }, signal);

    await vi.waitFor(async () => expect(await log(files.logPath)).toHaveLength(2));
    const entries = await log(files.logPath);
    expect(entries.every((entry) => entry.argv.length === 0)).toBe(true);
    expect(entries[1]?.request.input).toEqual({ request: "screen" });
  });

  it("keeps recordings isolated by agent and stops only the named agent's process", async () => {
    const files = await fixture();
    const { desktop } = client(files);
    const signal = new AbortController().signal;
    const a = await desktop.handle({ agentId: "agent_a", action: "audio_start", input: { maxDurationSeconds: 90 } }, signal);
    const b = await desktop.handle({ agentId: "agent_b", action: "audio_start", input: {} }, signal);
    expect(a).toMatchObject({ recordingId: "rec-agent_a", state: "recording" });
    expect(b).toMatchObject({ recordingId: "rec-agent_b", state: "recording" });

    await expect(desktop.handle({ agentId: "agent_c", action: "audio_stop", input: { recordingId: "rec-agent_a" } }, signal))
      .rejects.toMatchObject({ code: "no_recording" });
    const stoppedB = await desktop.handle({ agentId: "agent_b", action: "audio_stop", input: { recordingId: "rec-agent_b" } }, signal);
    expect(stoppedB).toMatchObject({ recordingId: "rec-agent_b", state: "stopped" });
    const stoppedA = await desktop.handle({ agentId: "agent_a", action: "audio_stop", input: { recordingId: "rec-agent_a" } }, signal);
    expect(stoppedA).toMatchObject({ recordingId: "rec-agent_a", state: "stopped" });

    const entries = await log(files.logPath);
    expect(entries.find((entry) => entry.type === "request" && entry.request.action === "audio_start")?.request.input.folder).toBe(files.root);
    expect(entries.filter((entry) => entry.type === "signal").map((entry) => entry.recordingId).sort()).toEqual(["rec-agent_a", "rec-agent_b"]);
  });

  it("rejects stale, wrong and missing recording IDs without signaling the current recording", async () => {
    const files = await fixture();
    const { desktop } = client(files);
    const signal = new AbortController().signal;
    await desktop.handle({ agentId: "agent_a", action: "audio_start", input: {} }, signal);
    await desktop.handle({ agentId: "agent_a", action: "audio_stop", input: { recordingId: "rec-agent_a" } }, signal);
    await desktop.handle({ agentId: "agent_a", action: "audio_start", input: { generation: "-new" } }, signal);
    const entries = await log(files.logPath);
    const current = entries.findLast((entry) => entry.type === "request" && entry.request.action === "audio_start");
    const pid = Number(current?.pid);
    expect(pid).toBeGreaterThan(0);

    for (const input of [{ recordingId: "rec-agent_a" }, { recordingId: "rec-agent_b" }, {}, { recordingId: 42 }]) {
      await expect(desktop.handle({ agentId: "agent_a", action: "audio_stop", input }, signal))
        .rejects.toMatchObject({ code: "recording_mismatch" });
    }
    // Wait beyond both escalation windows: a rejected stop must not schedule delayed termination.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect((await log(files.logPath)).filter((entry) => entry.type === "signal" && entry.pid === pid)).toEqual([]);
    await expect(desktop.handle({ agentId: "agent_a", action: "audio_start", input: {} }, signal))
      .rejects.toMatchObject({ code: "already_recording" });
    await expect(desktop.handle({ agentId: "agent_a", action: "audio_stop", input: { recordingId: "rec-agent_a-new" } }, signal))
      .resolves.toMatchObject({ recordingId: "rec-agent_a-new", state: "stopped" });
    expect((await log(files.logPath)).filter((entry) => entry.type === "signal" && entry.pid === pid)).toHaveLength(1);
  });

  it("serves only the browser, audio, permissions and Mac apps: screenshots, input and the old control mode belong to cua-driver or are gone", async () => {
    const files = await fixture();
    const browser = vi.fn(async () => ({ url: "https://example.test" }));
    const { desktop } = client(files, browser);
    const signal = new AbortController().signal;
    for (const action of ["screenshot", "click", "type", "key", "scroll", "move", "control"]) {
      await expect(desktop.handle({ agentId: "agent_a", action, input: {} }, signal)).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(await desktop.handle({ agentId: "agent_a", action: "browser", input: { action: "navigate" } }, signal)).toEqual({ url: "https://example.test" });
    expect(browser).toHaveBeenCalledWith("agent_a", { action: "navigate" }, expect.any(AbortSignal));
    expect(await log(files.logPath)).toEqual([]);
  });

  it("aborts and escalates a stuck child without closing the desktop host", async () => {
    const files = await fixture();
    const { desktop } = client(files);
    const controller = new AbortController();
    let stuckPid = 0;
    const pending = desktop.handle(
      { agentId: "agent_a", action: "permissions", input: { hang: true } },
      controller.signal,
    );
    await vi.waitFor(async () => {
      const current = await log(files.logPath);
      expect(current.some((entry) => entry.type === "ready")).toBe(true);
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });

    const entries = await vi.waitFor(async () => {
      const current = await log(files.logPath);
      expect(current.some((entry) => entry.type === "ignored" && entry.signal === "SIGTERM")).toBe(true);
      return current;
    }, { timeout: 5_000 });
    stuckPid = Number(entries.find((entry) => entry.type === "request")?.pid);
    expect(stuckPid).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(() => process.kill(stuckPid, 0)).toThrow();
    });

    await expect(desktop.handle({ agentId: "agent_a", action: "permissions", input: {} }, new AbortController().signal))
      .resolves.toMatchObject({ audio: true });

    const audio = new AbortController();
    await desktop.handle({ agentId: "agent_a", action: "audio_start", input: {} }, audio.signal);
    audio.abort();
    await vi.waitFor(async () => {
      const entries = await log(files.logPath);
      expect(entries.some((entry) => entry.type === "signal" && entry.agentId === "agent_a")).toBe(true);
    });
    await expect(desktop.handle({ agentId: "agent_a", action: "audio_stop", input: { recordingId: "rec-agent_a" } }, new AbortController().signal))
      .rejects.toMatchObject({ code: "no_recording" });
  }, 8_000);

  it("stop interrupts every live recording and leaves the host reusable", async () => {
    const files = await fixture();
    const { desktop } = client(files);
    const signal = new AbortController().signal;
    await desktop.handle({ agentId: "agent_a", action: "audio_start", input: {} }, signal);
    await desktop.handle({ agentId: "agent_b", action: "audio_start", input: {} }, signal);
    desktop.stop();

    await vi.waitFor(async () => {
      const entries = await log(files.logPath);
      expect(entries.filter((entry) => entry.type === "signal")).toHaveLength(2);
    });
    await expect(desktop.handle({ agentId: "agent_c", action: "permissions", input: {} }, signal))
      .resolves.toMatchObject({ audio: true });
    await expect(desktop.handle({ agentId: "agent_a", action: "audio_stop", input: { recordingId: "rec-agent_a" } }, signal))
      .rejects.toBeInstanceOf(MacDesktopError);
  });

  it("never maps Chrome page pixels onto another app's window", async () => {
    const browser = vi.fn(async () => ({ action: "point" }));
    const host = createMacDesktop({ folder: "/tmp/Juno", helperPath: "/unused", browser });
    await expect(host.handle({ agentId: "agent-a", action: "browser", input: { action: "point", x: 20, y: 30 } }, new AbortController().signal)).rejects.toMatchObject({ code: "coordinate_mapping_unavailable" });
    expect(browser).not.toHaveBeenCalled();
  });

  it("reports a missing helper instead of hanging", async () => {
    const files = await fixture();
    const desktop = createMacDesktop({
      folder: files.root,
      helperPath: join(files.root, "missing-helper"),
      browser: vi.fn(async () => ({ ok: true })),
    });
    HOSTS.push(desktop);
    await expect(desktop.handle({ agentId: "agent_a", action: "permissions", input: {} }, new AbortController().signal))
      .rejects.toMatchObject({ code: "helper_unavailable" });
  });
});
