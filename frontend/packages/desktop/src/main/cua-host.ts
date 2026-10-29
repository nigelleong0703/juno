/**
 * cua-driver for this Mac. Juno starts `cua-driver serve --embedded` as its own child (never through LaunchServices), so macOS
 * charges Screen Recording and Accessibility to Juno and the user sees no second app in System Settings. The link daemon gets a
 * client for the daemon's private socket (`juno-link/cua`); this file only keeps the daemon running.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCuaCliClient, type CuaClient } from "juno-link/cua";

export interface CuaPermissions {
  screen: boolean;
  accessibility: boolean;
  /** The grants are Juno's (`source.attribution` is `host`); anything else means embedding is not in effect. */
  host: boolean;
}

export interface CuaHostOptions {
  binaryPath: string;
  /** Echoed by cua in check_permissions and its logs; not a trust signal. */
  hostBundleId: string;
  log(message: string): void;
  /** Called when the daemon goes up or down. */
  onChange(): void;
  /** Tests inject a fake. */
  spawn?: typeof nodeSpawn;
}

export interface CuaHost {
  /** The client handed to the link daemon. Calls fail while the daemon is down. */
  readonly client: CuaClient;
  running(): boolean;
  /** Starts the daemon; resolves once its socket accepts connections. A daemon that dies later is restarted. */
  start(): Promise<void>;
  /** Fresh read of Juno's grants as the daemon sees them. */
  permissions(signal?: AbortSignal): Promise<CuaPermissions>;
  /** macOS caches grants per process: after one changes, a new daemon sees it. */
  restart(): Promise<void>;
  /** Quit: no restart, socket removed. */
  stop(): Promise<void>;
}

const READY_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
const RESTART_BASE_MS = 1_000;
const RESTART_MAX_MS = 30_000;
const STABLE_MS = 60_000;
const STOP_GRACE_MS = 2_000;

export function createCuaHost(options: CuaHostOptions): CuaHost {
  const spawn = options.spawn ?? nodeSpawn;
  // A private 0700 directory: nothing else on this Mac can put its own socket where Juno will connect.
  const dir = mkdtempSync(join(tmpdir(), "juno-cua-"));
  const socketPath = join(dir, "cua.sock");
  const client = createCuaCliClient({ socketPath, binaryPath: options.binaryPath });
  let child: ChildProcess | undefined;
  let up = false;
  let stopping = false;
  let starting: Promise<void> | undefined;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const waitForSocket = (proc: ChildProcess): Promise<void> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      const exited = () => reject(new Error("cua-driver exited before it was ready"));
      proc.once("exit", exited);
      const attempt = () => {
        if (proc.exitCode !== null) return;
        const socket = connect(socketPath);
        socket.once("connect", () => {
          socket.destroy();
          proc.off("exit", exited);
          resolve();
        });
        socket.once("error", () => {
          socket.destroy();
          if (Date.now() > deadline) {
            proc.off("exit", exited);
            reject(new Error("cua-driver did not open its socket"));
          } else setTimeout(attempt, POLL_MS);
        });
      };
      attempt();
    });

  const scheduleRestart = () => {
    if (stopping || retry !== undefined) return;
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** failures);
    failures += 1;
    options.log(`cua-driver restarts in ${delay} ms`);
    retry = setTimeout(() => {
      retry = undefined;
      void launch().catch((error) => options.log(`cua-driver restart failed: ${error instanceof Error ? error.message : String(error)}`));
    }, delay);
    retry.unref();
  };

  const launch = async (): Promise<void> => {
    if (stopping || child !== undefined) return;
    if (!existsSync(options.binaryPath)) throw new Error(`cua-driver is missing at ${options.binaryPath}`);
    rmSync(socketPath, { force: true });
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("ELECTRON_")) env[name] = value;
    // EMBEDDED keeps the daemon in Juno's TCC chain; LIVENESS_STDIN makes it exit with Juno even if Juno is killed.
    env["CUA_DRIVER_EMBEDDED"] = "1";
    env["CUA_DRIVER_HOST_BUNDLE_ID"] = options.hostBundleId;
    env["CUA_DRIVER_PARENT_LIVENESS_STDIN"] = "1";
    const proc = spawn(options.binaryPath, ["serve", "--embedded", "--socket", socketPath], { stdio: ["pipe", "ignore", "pipe"], env });
    child = proc;
    const startedAt = Date.now();
    let tail = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => { tail = (tail + chunk).slice(-2_000); });
    proc.once("exit", (code, signal) => {
      if (child !== proc) return;
      child = undefined;
      const wasUp = up;
      up = false;
      if (Date.now() - startedAt > STABLE_MS) failures = 0;
      options.log(`cua-driver exited (${signal ?? `code ${String(code)}`})${tail.trim() === "" ? "" : `: ${tail.trim().slice(-300)}`}`);
      if (wasUp) options.onChange();
      scheduleRestart();
    });
    proc.once("error", (error) => options.log(`cua-driver could not start: ${error.message}`));
    try {
      await waitForSocket(proc);
    } catch (error) {
      proc.kill("SIGTERM");
      throw error;
    }
    up = true;
    options.log("cua-driver is running");
    options.onChange();
  };

  const terminate = (proc: ChildProcess): Promise<void> =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      const kill = setTimeout(() => proc.kill("SIGKILL"), STOP_GRACE_MS);
      proc.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      proc.kill("SIGTERM");
    });

  return {
    client,
    running: () => up,
    start() {
      if (stopping) return Promise.reject(new Error("cua-driver is stopped"));
      starting ??= launch().then(
        () => { starting = undefined; },
        (error: unknown) => {
          starting = undefined;
          // A build without the binary has nothing to retry.
          if (existsSync(options.binaryPath)) scheduleRestart();
          throw error;
        },
      );
      return starting;
    },
    async permissions(signal = new AbortController().signal) {
      const answer = await client.call("check_permissions", {}, signal);
      const json = answer.json;
      const source = typeof json === "object" && json !== null ? Reflect.get(json, "source") : undefined;
      const read = (key: string) => typeof json === "object" && json !== null && Reflect.get(json, key) === true;
      return {
        screen: read("screen_recording"),
        accessibility: read("accessibility"),
        host: typeof source === "object" && source !== null && Reflect.get(source, "attribution") === "host",
      };
    },
    async restart() {
      const proc = child;
      if (proc === undefined) {
        failures = 0;
        return launch();
      }
      // Our own kill must not count as a crash: detach it from the restart path first.
      child = undefined;
      const wasUp = up;
      up = false;
      if (wasUp) options.onChange();
      await terminate(proc);
      return launch();
    },
    async stop() {
      stopping = true;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      const proc = child;
      child = undefined;
      up = false;
      if (proc !== undefined) await terminate(proc);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
