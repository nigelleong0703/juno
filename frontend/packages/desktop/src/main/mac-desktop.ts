import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { runMacApp, type MacAppsExec } from "./mac-apps";

type JsonObject = Record<string, unknown>;

export interface MacDesktopOptions {
  /** The one folder this Mac exposes; system recordings live below its Recordings directory. */
  folder: string;
  /** The signed juno-mac-helper executable emitted by scripts/build-mac-helper.mjs. */
  helperPath: string;
  browser(agentId: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** Runs osascript for the Mail/Calendar/Reminders tools; tests pass a fake. */
  appsExec?: MacAppsExec;
}

export interface MacDesktop {
  handle(request: { agentId: string; action: string; input: Record<string, unknown> }, signal: AbortSignal): Promise<unknown>;
  /** Cancels helper work and recordings. A later request starts fresh processes. */
  stop(): void;
}

export class MacDesktopError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "MacDesktopError";
    this.code = code;
    this.details = details;
  }
}

// Screenshots and input are cua-driver's (the link daemon serves snapshot, act and verify itself); this host keeps the rest.
const ACTIONS = new Set(["browser", "audio_start", "audio_stop", "permissions", "mac_apps"]);
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_HELPER_REQUEST_BYTES = 999_999;
// The link frame cap is 1 MiB including its five-byte envelope. Reserve another 200 bytes for
// callers that add a small JSON wrapper or transport metadata around the helper result.
const MAX_HELPER_RESPONSE_BYTES = 1_048_371;
const RESPONSE_TIMEOUT_MS = 60_000;
const AUDIO_START_TIMEOUT_MS = 30_000;
const INTERRUPT_GRACE_MS = 1_500;
const TERMINATE_GRACE_MS = 800;
const STOP_WAIT_MS = INTERRUPT_GRACE_MS + TERMINATE_GRACE_MS + 1_500;

interface Recording {
  process: HelperProcess;
  path: string;
  recordingId: string;
}

export function createMacDesktop(options: MacDesktopOptions): MacDesktop {
  const recordings = new Map<string, Recording>();
  const processes = new Set<HelperProcess>();
  const browserCalls = new Set<{ agentId: string; controller: AbortController }>();

  const stopRecording = async (agentId: string, recordingId: unknown): Promise<unknown> => {
    const recording = recordings.get(agentId);
    if (recording === undefined) {
      throw new MacDesktopError("no_recording", `agent ${agentId} has no system audio recording`);
    }
    if (typeof recordingId !== "string" || recordingId !== recording.recordingId) {
      throw new MacDesktopError("recording_mismatch", "audio_stop.recordingId must match the agent's current recording");
    }
    recording.process.terminate("audio_stop");
    await withTimeout(recording.process.closed, STOP_WAIT_MS, "the audio helper did not stop in time");
    recordings.delete(agentId);
    const final = recording.process.messages.at(-1);
    if (!isObject(final) || final["state"] !== "stopped" || final["recordingId"] !== recording.recordingId) {
      if (isObject(final) && final["state"] === "failed") throw helperFailure(final);
      throw new MacDesktopError("stop_failed", "the audio helper exited without finalizing the recording", final);
    }
    return final;
  };

  return {
    async handle(request, signal) {
      validateRequest(request);
      if (signal.aborted) throw abortFailure();

      if (request.action === "mac_apps") {
        try {
          return { text: await runMacApp(request.input["tool"], request.input["args"], options.appsExec) };
        } catch (error) {
          throw new MacDesktopError("mac_apps_failed", error instanceof Error ? error.message : "the Mac call failed");
        }
      }

      if (request.action === "audio_stop") return stopRecording(request.agentId, request.input["recordingId"]);

      if (request.action === "browser") {
        // Chrome's page coordinates do not map onto another app's window pixels. Until that geometry is verified,
        // never identify a different control as the purchase target.
        if (request.input["action"] === "bounds" || (request.input["action"] === "point" && (request.input["x"] !== undefined || request.input["y"] !== undefined))) {
          throw new MacDesktopError("coordinate_mapping_unavailable", "Chrome-to-Mac coordinate lookup is not available. Use the exact browser ref for browser actions.");
        }
        return runBrowser(options.browser, request.agentId, request.input, signal, browserCalls);
      }

      if (request.action === "audio_start" && recordings.has(request.agentId)) {
        throw new MacDesktopError("already_recording", `agent ${request.agentId} is already recording system audio`);
      }

      const helperInput: JsonObject = { ...request.input };
      if (request.action === "audio_start") helperInput["folder"] = options.folder;
      const helperRequest = { agentId: request.agentId, action: request.action, input: helperInput };
      const payload = JSON.stringify(helperRequest);
      if (Buffer.byteLength(payload, "utf8") >= MAX_HELPER_REQUEST_BYTES) {
        throw new MacDesktopError("too_large", "the desktop request exceeds one Juno link frame");
      }

      const helper = new HelperProcess(options.helperPath);
      processes.add(helper);
      void helper.closed.finally(() => processes.delete(helper));
      const abort = () => helper.terminate("request_aborted");
      signal.addEventListener("abort", abort, { once: true });
      const followRecording = request.action === "audio_start";
      try {
        let response: unknown;
        try {
          const timeout = request.action === "audio_start"
            ? AUDIO_START_TIMEOUT_MS
            : request.action === "permissions" && helperInput["request"] !== undefined
              ? 300_000
              : RESPONSE_TIMEOUT_MS;
          response = await helper.send(payload, timeout);
        } catch (error) {
          if (signal.aborted) throw abortFailure();
          throw error;
        }
        if (signal.aborted) throw abortFailure();

        if (request.action === "audio_start") {
          if (!isObject(response) || response["state"] !== "recording" || typeof response["recordingId"] !== "string" || typeof response["path"] !== "string") {
            throw new MacDesktopError("protocol", "the helper did not return a recording identity", response);
          }
          const path = recordingPath(options.folder, response["recordingId"], response["path"]);
          const recording = { process: helper, path, recordingId: response["recordingId"] };
          recordings.set(request.agentId, recording);
          const forget = () => {
            if (recordings.get(request.agentId) === recording) recordings.delete(request.agentId);
          };
          signal.addEventListener("abort", forget, { once: true });
          void helper.closed.then(() => {
            forget();
            signal.removeEventListener("abort", forget);
          });
        } else {
          void withTimeout(helper.closed, 2_000, "the helper did not exit after its response")
            .catch(() => helper.terminate("exit_timeout"));
        }
        return response;
      } finally {
        if (followRecording) {
          void helper.closed.finally(() => signal.removeEventListener("abort", abort));
        } else {
          signal.removeEventListener("abort", abort);
        }
      }
    },

    stop() {
      for (const helper of processes) helper.terminate("host_stop");
      recordings.clear();
      for (const call of browserCalls) call.controller.abort(new DOMException("desktop stopped", "AbortError"));
      browserCalls.clear();
    },
  };
}

function validateRequest(request: { agentId: string; action: string; input: Record<string, unknown> }): void {
  if (typeof request !== "object" || request === null) throw new MacDesktopError("bad_request", "desktop request is missing");
  if (typeof request.agentId !== "string" || !AGENT_ID.test(request.agentId)) {
    throw new MacDesktopError("bad_request", "desktop request has an invalid agent id");
  }
  if (typeof request.action !== "string" || !ACTIONS.has(request.action)) {
    throw new MacDesktopError("bad_request", `unsupported desktop action: ${String(request.action)}`);
  }
  if (!isObject(request.input)) throw new MacDesktopError("bad_request", "desktop request input must be an object");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordingPath(folder: string, recordingId: string, value: unknown): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(recordingId) || typeof value !== "string") {
    throw new MacDesktopError("protocol", "the helper returned an invalid recording path");
  }
  const recordings = resolve(folder, "Recordings");
  const path = resolve(value);
  const inside = relative(recordings, path);
  if (inside.startsWith("..") || isAbsolute(inside) || basename(path) !== `${recordingId}.caf`) {
    throw new MacDesktopError("protocol", "the helper returned a recording outside the Juno Recordings folder");
  }
  return path;
}

function helperFailure(value: JsonObject): MacDesktopError {
  const error = isObject(value["error"]) ? value["error"] : undefined;
  const code = typeof error?.["code"] === "string" ? error["code"] : "helper_failed";
  const message = typeof error?.["message"] === "string" ? error["message"] : "the macOS helper failed";
  return new MacDesktopError(code, message, value);
}

function abortFailure(): MacDesktopError {
  const error = new MacDesktopError("cancelled", "the desktop request was cancelled");
  error.name = "AbortError";
  return error;
}

async function runBrowser(
  browser: MacDesktopOptions["browser"],
  agentId: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
  active: Set<{ agentId: string; controller: AbortController }>,
): Promise<unknown> {
  const call = { agentId, controller: new AbortController() };
  active.add(call);
  try {
    return await browser(agentId, input, AbortSignal.any([signal, call.controller.signal]));
  } finally {
    active.delete(call);
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MacDesktopError("timeout", message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class HelperProcess {
  readonly closed: Promise<void>;
  readonly messages: unknown[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly first: Promise<unknown>;
  private resolveFirst!: (value: unknown) => void;
  private rejectFirst!: (reason: unknown) => void;
  private resolveClosed!: () => void;
  private settledFirst = false;
  private stdout = "";
  private stderr = "";
  private exited = false;
  private interruptTimer?: ReturnType<typeof setTimeout>;
  private terminateTimer?: ReturnType<typeof setTimeout>;

  constructor(helperPath: string) {
    this.first = new Promise((resolve, reject) => {
      this.resolveFirst = resolve;
      this.rejectFirst = reject;
    });
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    // The request travels only on stdin. Keeping argv empty avoids leaking typed text through the process list.
    this.child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.readStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      if (this.stderr.length < 32_768) this.stderr += chunk.slice(0, 32_768 - this.stderr.length);
    });
    this.child.on("error", (error) => {
      if (!this.settledFirst) this.settleFirst(new MacDesktopError("helper_unavailable", `could not start the signed macOS helper: ${error.message}`));
    });
    this.child.on("close", (code, signal) => {
      if (this.stdout.trim() !== "") this.acceptLine(this.stdout);
      this.stdout = "";
      this.exited = true;
      this.clearKillTimers();
      if (!this.settledFirst) {
        const detail = this.stderr.trim();
        this.settleFirst(new MacDesktopError(
          "helper_exited",
          `the macOS helper exited before returning a response (${signal ?? `code ${String(code)}`})${detail === "" ? "" : `: ${detail}`}`,
        ));
      }
      this.resolveClosed();
    });
  }

  async send(payload: string, timeoutMs: number): Promise<unknown> {
    this.child.stdin.end(payload);
    const timer = setTimeout(() => {
      this.terminate("timeout");
    }, timeoutMs);
    timer.unref?.();
    try {
      return await this.first;
    } finally {
      clearTimeout(timer);
    }
  }

  terminate(reason: string): void {
    void reason;
    if (this.exited || this.child.exitCode !== null) return;
    try { this.child.kill("SIGINT"); } catch { /* the close/error handler settles the request */ }
    if (this.interruptTimer === undefined) {
      this.interruptTimer = setTimeout(() => {
        if (this.exited) return;
        try { this.child.kill("SIGTERM"); } catch { /* escalate below */ }
        this.terminateTimer = setTimeout(() => {
          if (!this.exited) {
            try { this.child.kill("SIGKILL"); } catch { /* close/error settles it */ }
          }
        }, TERMINATE_GRACE_MS);
        this.terminateTimer.unref?.();
      }, INTERRUPT_GRACE_MS);
      this.interruptTimer.unref?.();
    }
  }

  private readStdout(chunk: string): void {
    this.stdout += chunk;
    if (Buffer.byteLength(this.stdout, "utf8") > MAX_HELPER_RESPONSE_BYTES) {
      this.stdout = "";
      this.terminate("response_too_large");
      this.settleFirst(new MacDesktopError("too_large", "the macOS helper response exceeds one Juno link frame"));
      return;
    }
    let newline = this.stdout.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      if (line.trim() !== "") this.acceptLine(line);
      newline = this.stdout.indexOf("\n");
    }
  }

  private acceptLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.terminate("bad_response");
      this.settleFirst(new MacDesktopError("protocol", "the macOS helper returned invalid JSON"));
      return;
    }
    this.messages.push(message);
    if (isObject(message) && message["ok"] === false) {
      this.settleFirst(helperFailure(message));
      return;
    }
    this.settleFirst(message);
  }

  private settleFirst(value: unknown): void {
    if (this.settledFirst) return;
    this.settledFirst = true;
    if (value instanceof Error) this.rejectFirst(value);
    else this.resolveFirst(value);
  }

  private clearKillTimers(): void {
    if (this.interruptTimer !== undefined) clearTimeout(this.interruptTimer);
    if (this.terminateTimer !== undefined) clearTimeout(this.terminateTimer);
  }
}
