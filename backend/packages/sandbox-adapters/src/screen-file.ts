/**
 * Screen-level file and capture operations on one display. Grouped apart from the connection
 * lifecycle: these run a command with `DISPLAY=:N`, read the PNG back, drive Chromium and read or
 * write files in the shared `/workspace`.
 *
 * Everything runs against the narrow `SandboxRuntime` (see `runtime.ts`), so the same helpers
 * drive E2B (`e2b-runtime.ts` adapts the SDK `Sandbox`) and local/docker runtimes alike.
 */
import type { CommandResult, SandboxRuntime } from './runtime.js';
import { commandExitResult } from './runtime.js';
import type {
  FileContent,
  FileWriteRequest,
  FileWriteResult,
  NavigateResult,
  Screenshot,
  ShellInput,
  ShellOutput,
} from './types.js';
import { failed } from './errors.js';
import { BROWSER_TIMEOUT_MS, browserCommand, parseBrowserOutput } from './browser.js';
import type { BrowserInput, BrowserResult } from './browser.js';
import { MEET_TIMEOUT_MS, meetCommand, parseMeetOutput, type MeetInput, type MeetResult } from './meet.js';
import { displayShell, imageInfo, shq } from './screen-boot.js';
import { modelScale } from './model-screen.js';
import { screenPorts } from './ports.js';

/** Codex utils/image PromptImageMode::HIGH_DETAIL: longest side and 32px-patch budget of a prompt image. */
export const MAX_IMAGE_DIMENSION = 2048;
export const MAX_IMAGE_PATCHES = 2_500;
const PATCH_SIZE = 32;
/** ffmpeg mjpeg quality scale (2 best, 31 worst): about libjpeg quality 70 for a screenshot. */
const JPEG_QSCALE = 6;

const fits = (width: number, height: number) =>
  width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION && Math.ceil(width / PATCH_SIZE) * Math.ceil(height / PATCH_SIZE) <= MAX_IMAGE_PATCHES;

/** Port of Codex `prompt_image_output_dimensions_for_limits`: fit the longest side, then the patch budget by area. */
export function promptImageDimensions(width: number, height: number): { width: number; height: number } {
  let w = Math.max(1, width);
  let h = Math.max(1, height);
  if (fits(w, h)) return { width: w, height: h };
  const dimensionScale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(w, h));
  w = Math.max(1, Math.round(w * dimensionScale));
  h = Math.max(1, Math.round(h * dimensionScale));
  if (fits(w, h)) return { width: w, height: h };
  let scale = Math.sqrt((PATCH_SIZE * PATCH_SIZE * MAX_IMAGE_PATCHES) / w / h);
  const wide = (w * scale) / PATCH_SIZE;
  const high = (h * scale) / PATCH_SIZE;
  scale *= Math.min(Math.floor(wide) / wide, Math.floor(high) / high);
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

/** The model image size for a captured image: the WXGA fit, then Codex's patch budget. */
export function modelImageDimensions(width: number, height: number): { width: number; height: number } {
  const scale = modelScale(width, height);
  return promptImageDimensions(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
}

export interface ScreenFile {
  runOnDisplay(runtime: SandboxRuntime, displayNo: number, command: string, timeoutMs?: number): Promise<CommandResult>;
  screenshot(runtime: SandboxRuntime, displayNo: number): Promise<Screenshot>;
  navigate(runtime: SandboxRuntime, agentId: string, displayNo: number, url: string): Promise<NavigateResult>;
  browser(runtime: SandboxRuntime, displayNo: number, input: BrowserInput): Promise<BrowserResult>;
  meet(runtime: SandboxRuntime, displayNo: number, input: MeetInput): Promise<MeetResult>;
  shell(runtime: SandboxRuntime, displayNo: number, input: ShellInput): Promise<ShellOutput>;
  readFile(runtime: SandboxRuntime, path: string): Promise<FileContent>;
  writeFile(runtime: SandboxRuntime, input: FileWriteRequest): Promise<FileWriteResult>;
}

export function createScreenFile(): ScreenFile {
  return {
    runOnDisplay(runtime, displayNo, command, timeoutMs = 60_000) {
      return runtime.run(displayShell(displayNo, command), { envs: { DISPLAY: `:${displayNo}` }, timeoutMs });
    },

    async screenshot(runtime, displayNo) {
      // Prepared once, here, before it enters the history, and replayed unchanged after that. The model sees it at
      // the model screen size (modelImageDimensions: fit 1280x800, then Codex's utils/image HIGH_DETAIL budget of
      // 2048px / 2,500 32px patches) and encoded as JPEG (~70 quality, about 5-10x smaller than PNG; every
      // re-sent screenshot costs that much per call). No encoder in the image: the PNG path below, as before.
      const remote = `/tmp/agent-shot-${displayNo}-${Date.now()}.png`;
      const scaled = remote.replace(/\.png$/, '-fit.png');
      const jpeg = remote.replace(/\.png$/, '-model.jpg');
      const capture = await runtime.run(`DISPLAY=:${displayNo} scrot -o --pointer ${shq(remote)}`, { timeoutMs: 30_000 });
      if (capture.exitCode !== 0) throw failed(`screenshot failed: ${capture.stderr || capture.stdout}`);
      try {
        const captured = await runtime.readBytes(remote);
        const info = imageInfo(captured);
        const target = modelImageDimensions(info.width, info.height);
        const encode = await runtime.run(`ffmpeg -y -loglevel error -i ${shq(remote)} -vf scale=${target.width}:${target.height}:flags=bilinear -q:v ${JPEG_QSCALE} ${shq(jpeg)}`, { timeoutMs: 30_000 });
        if (encode.exitCode === 0) return shotOf(await runtime.readBytes(jpeg), displayNo);
        let bytes = captured;
        if (target.width !== info.width || target.height !== info.height) {
          const resize = await runtime.run(`ffmpeg -y -loglevel error -i ${shq(remote)} -vf scale=${target.width}:${target.height}:flags=bilinear ${shq(scaled)}`, { timeoutMs: 30_000 });
          if (resize.exitCode === 0) bytes = await runtime.readBytes(scaled);
        }
        return shotOf(bytes, displayNo);
      } finally {
        await runtime.run(`rm -f ${shq(remote)} ${shq(scaled)} ${shq(jpeg)}`, { timeoutMs: 10_000 }).catch(() => undefined);
      }
    },

    async navigate(runtime, agentId, displayNo, url) {
      void agentId;
      // The live Chromium owns its profile and CDP port; navigating drives it through the
      // browser helper instead of launching a second shell browser, and reports the real page.
      const page = await runBrowser(runtime, displayNo, { action: 'navigate', url });
      if (page.action !== 'navigate') throw failed(`browser navigate returned a ${page.action} result`);
      return { url: page.url, title: page.title };
    },

    async browser(runtime, displayNo, input) {
      return runBrowser(runtime, displayNo, input);
    },

    async meet(runtime, displayNo, input) {
      const result = await runtime.run(meetCommand(displayNo, input), { timeoutMs: MEET_TIMEOUT_MS });
      return parseMeetOutput(result.stdout, result.stderr, result.exitCode, input.action);
    },

    async shell(runtime, displayNo, input) {
      try {
        // JUNO_CDP_PORT is this agent's own browser debugging port (the shell may use it, see isolation.ts ownAgentCdpRules).
        const result = await runtime.run(displayShell(displayNo, input.command), {
          envs: { DISPLAY: `:${displayNo}`, JUNO_CDP_PORT: String(screenPorts(displayNo).cdp) },
          timeoutMs: input.timeoutMs,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      } catch (error) {
        // A non-zero exit is a normal result, not a backend failure. Some runtimes report it by
        // THROWING a value with the command-exit shape (E2B's `CommandExitError`); detect the
        // shape instead of `instanceof`, which is unreliable across module instances. A real
        // transport failure has none of these fields and still propagates.
        const exit = commandExitResult(error);
        if (exit) {
          return { stdout: exit.stdout, stderr: exit.stderr, exitCode: exit.exitCode };
        }
        throw error;
      }
    },

    async readFile(runtime, path) {
      try {
        const content = await runtime.readText(path);
        return { content, bytes: Buffer.byteLength(content) };
      } catch (error) {
        throw failed(`could not read ${path}: ${message(error)}`);
      }
    },

    async writeFile(runtime, input) {
      try {
        await runtime.writeText(input.path, input.content);
        return { path: input.path, bytes: Buffer.byteLength(input.content) };
      } catch (error) {
        throw failed(`could not write ${input.path}: ${message(error)}`);
      }
    },
  };
}

/** A captured image as the screenshot the model and the transcript see; its type comes from its own bytes. */
function shotOf(bytes: Uint8Array, displayNo: number): Screenshot {
  const { mimeType, width, height } = imageInfo(bytes);
  return { data: Buffer.from(bytes).toString('base64'), mimeType, width, height, displayNo };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One typed browser call through the sandbox-local helper on the display's CDP port (`runtime` is the platform's root runtime). */
async function runBrowser(runtime: SandboxRuntime, displayNo: number, input: BrowserInput): Promise<BrowserResult> {
  const result = await runtime.run(browserCommand(displayNo, input), { timeoutMs: BROWSER_TIMEOUT_MS });
  return parseBrowserOutput(result.stdout, result.stderr, result.exitCode, input.action);
}
