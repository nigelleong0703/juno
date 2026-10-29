/**
 * In-memory provider for unit tests. It behaves like a live VM — including per-screen state and a
 * small scriptable surface — without a sandbox, so the executor, routes and stream proxy can be
 * tested deterministically.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BrowserDownError, failed, noScreen } from './errors.js';
import type { SandboxRuntime } from './runtime.js';
import type { ComputerProvider } from './provider.js';
import type { BrowserInput, BrowserResult } from './browser.js';
import type {
  ClipboardCopyResult,
  ClipboardPaste,
  ScreenActionResult,
  ScreenHandle,
  Screenshot,
} from './types.js';
import { parseResolution } from './types.js';
import { parseEnvironment, type ComputerEnvironment } from './environment.js';
import { screenPorts, MAX_LIVE_SCREENS } from './ports.js';
import { SPACE_PORTS } from './spaces.js';
import { createFakeProcesses } from './fake-processes.js';
import { HOME_ROOT } from 'juno-agent/modules/home/paths';
import { READ_SCRIPT } from 'juno-agent/modules/tools/tools/sandboxFile';

/** The real gateway script (packages/sandbox-image/files/spaces/gateway.mjs), run under Node for the fake computer. */
const GATEWAY_SCRIPT = fileURLToPath(new URL('../../sandbox-image/files/spaces/gateway.mjs', import.meta.url));

/** True when something accepts a connection on 127.0.0.1:port on THIS host (the fake cannot tell whose uid holds it). */
function hostPortListens(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ port, host: '127.0.0.1' });
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

function freeHostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address !== null && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

export interface FakeProviderOptions {
  sandboxId?: string;
  /** Per-display screen contents the tests can read after a write. */
  files?: Map<string, string>;
  /**
   * Explicit fake environment values. Defaults keep the double obviously non-local: no
   * value here is ever read from the local process.
   */
  environment?: Partial<Pick<ComputerEnvironment, 'os' | 'platform' | 'user' | 'home' | 'workingDirectory'>>;
}

export interface FakeProvider extends ComputerProvider {
  readonly screens: Map<number, ScreenHandle>;
  readonly shellCalls: string[];
  readonly files: Map<string, string>;
  /** The fake computer's `$HOME` (a real temp directory, created on first use) for tests that inspect `/juno`. */
  homeDir(): Promise<string>;
  /** handle -> owning agent for the in-memory process double. */
  readonly processScopes: Map<string, string>;
  /** Presences set by a shell command or a file write, asserted by tests. */
  readonly state: {
    pauseCalls: number;
    connectCalls: number;
    /** Browser/navigate calls that still fail as a dead Chromium; each failure uses one. */
    browserOutages: number;
    /** What the computer's clipboard holds for the next copy (set by a test; empty by default). */
    clipboard: ClipboardCopyResult;
    /** Every paste the computer received, in order. */
    pasted: ClipboardPaste[];
  };
}

export function createFakeProvider(opts: FakeProviderOptions = {}): FakeProvider {
  const screens = new Map<number, ScreenHandle>();
  const shellCalls: string[] = [];
  const files = opts.files ?? new Map<string, string>();
  const state: FakeProvider['state'] = { pauseCalls: 0, connectCalls: 0, browserOutages: 0, clipboard: { kind: 'empty' }, pasted: [] };
  const processes = createFakeProcesses();
  let allocation = 0;
  let tempDirs = 0;
  let paused = false;
  let homePath: string | undefined;
  /**
   * Spaces: the fake runs the REAL gateway script (under Node) on a loopback port with its own routes file. What it cannot do:
   * the root-only file, iptables, and the uid check of the listener. `registerSpace` only checks that something on this host
   * listens on the port (tests start a stub app there); the real check is covered by the LIVE_DOCKER test.
   */
  let gateway: { url: string; routesFile: string; child: ChildProcess } | undefined;
  async function fakeGateway(gatewayKey?: string): Promise<{ url: string; routesFile: string }> {
    // The key file is read by the gateway on every request, so writing it again is how the key is (re)installed.
    if (gatewayKey !== undefined) await writeFile(join(homeSync(), 'gateway.key'), gatewayKey, 'utf8');
    if (gateway !== undefined) return gateway;
    const port = await freeHostPort();
    const routesFile = join(homeSync(), 'spaces.json');
    const child = spawn(process.execPath, [GATEWAY_SCRIPT], { env: { PATH: process.env['PATH'] ?? '', JUNO_SPACES_PORT: String(port), JUNO_SPACES_HOST: '127.0.0.1', JUNO_SPACES_ROUTES: routesFile, JUNO_SPACES_KEY_FILE: join(homeSync(), 'gateway.key') }, stdio: 'ignore' });
    child.unref();
    process.once('exit', () => child.kill());
    gateway = { url: `http://127.0.0.1:${port}`, routesFile, child };
    for (let attempt = 0; attempt < 50 && !(await hostPortListens(port)); attempt += 1) await new Promise((done) => setTimeout(done, 100));
    return gateway;
  }
  const homeSync = (): string => (homePath ??= mkdtempSync(join(tmpdir(), 'fake-computer-')));
  const homeDir = async (): Promise<string> => homeSync();
  /** A real shell and filesystem under a temp directory, so the home scripts are exercised for real. */
  const runtime: SandboxRuntime = {
    // The real sandbox keeps the home at /juno; the double cannot, so it points the home scripts at a temp directory.
    get homeRoot() { return join(homeSync(), 'juno'); },
    async run(command, options) {
      const HOME = homeSync();
      return new Promise((resolve) => {
        execFile('/bin/sh', ['-c', command], { env: { ...process.env, HOME }, timeout: options?.timeoutMs }, (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
          resolve({ stdout, stderr, exitCode: code });
        });
      });
    },
    readText: (path) => readFile(path, 'utf8'),
    async readBytes(path) {
      return new Uint8Array(await readFile(path));
    },
    async writeText(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf8');
    },
    async writeBytes(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
  };

  /**
   * send_file and artifact_publish read a file with one fixed python3 script (the path is argv[1]). The double answers
   * exactly that script, for real: the in-memory file is written to a temp directory and the genuine script runs on it,
   * so size limit, base64 and sha256 are the production code's. A path the double does not hold answers "No such file"
   * (never a host path), and any other command keeps the canned echo, so nothing an agent types runs on the host.
   */
  async function fileReaderTarget(command: string): Promise<{ stdout: string; stderr: string; exitCode: number } | undefined> {
    const match = /^python3 -c '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'$/s.exec(command);
    if (match === null || (match[1] ?? '').replaceAll("'\\''", "'") !== READ_SCRIPT) return undefined;
    const path = (match[2] ?? '').replaceAll("'\\''", "'");
    const content = files.get(path);
    if (content === undefined) return ({ stdout: '', stderr: `FileNotFoundError: [Errno 2] No such file or directory: '${path}'`, exitCode: 1 });
    const local = join(homeSync(), 'workspace-files', createHash('sha256').update(path).digest('hex'));
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, content, 'utf8');
    return runtime.run(`python3 -c '${READ_SCRIPT.replaceAll("'", "'\\''")}' '${local}'`);
  }

  /**
   * A page thumbnail (renderPageThumbnail): the temporary directory is a made-up computer path, and the screenshot writes a stand-in
   * file into the in-memory files, which the production reader above then reads back, so the thumbnail is a stored file like a real one.
   */
  function fakePageTarget(command: string): { stdout: string; stderr: string; exitCode: number } | undefined {
    if (command === 'mktemp -d') {
      tempDirs += 1;
      return { stdout: `/tmp/fake-tmp-${String(tempDirs)}\n`, stderr: '', exitCode: 0 };
    }
    const shot = /--screenshot='((?:[^']|'\\'')*)'/.exec(command);
    if (shot === null) return undefined;
    files.set((shot[1] ?? '').replaceAll("'\\''", "'"), 'fake page thumbnail');
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  return {
    kind: 'fake',
    homeDir,
    screens,
    shellCalls,
    files,
    processScopes: processes.scopes,
    state,

    async create() {
      allocation += 1;
      return { sandboxId: opts.sandboxId ?? `fake-${allocation}`, template: 'fake' };
    },

    async connect() {
      state.connectCalls += 1;
      paused = false;
    },

    async pause() {
      state.pauseCalls += 1;
      paused = true;
    },

    async ensureScreen(_binding, request) {
      const existing = screens.get(request.displayNo);
      if (existing) return existing;
      if (screens.size >= MAX_LIVE_SCREENS) throw failed('too many live screens');
      const { width, height } = parseResolution(request.resolution);
      const ports = screenPorts(request.displayNo);
      const handle: ScreenHandle = {
        displayNo: request.displayNo,
        vncPort: ports.vnc,
        viewVncPort: ports.readOnlyVnc,
        webPort: ports.web,
        viewWebPort: ports.readOnlyWeb,
        cdpPort: ports.cdp,
        width,
        height,
        state: 'live',
      };
      screens.set(request.displayNo, handle);
      return handle;
    },

    invalidateScreen() {
      // The fake display has no cached boot to drop.
    },

    async stopScreen(_binding, displayNo) {
      screens.delete(displayNo);
    },

    async act(_binding, agentId, displayNo, action): Promise<ScreenActionResult> {
      if (!screens.has(displayNo)) throw noScreen(`screen :${displayNo} is not allocated`);
      if ((action.kind === 'browser' || action.kind === 'navigate') && state.browserOutages > 0) {
        state.browserOutages -= 1;
        throw new BrowserDownError(displayNo);
      }
      switch (action.kind) {
        case 'screenshot':
          return { screenshot: screenshot(displayNo, screens.get(displayNo)) };
        case 'shell': {
          shellCalls.push(action.input.command);
          const page = paused ? undefined : fakePageTarget(action.input.command);
          if (page !== undefined) return { shell: page };
          const read = paused ? undefined : await fileReaderTarget(action.input.command);
          if (read !== undefined) return { shell: read };
          return { shell: { stdout: `fake: ${action.input.command}\n`, stderr: '', exitCode: paused ? 1 : 0 } };
        }
        case 'writeFile':
          // Like the real VM, /juno is one real directory shared with the home endpoints, so an agent's file write lands where the sync looks.
          if (action.input.path.startsWith(HOME_ROOT + '/')) await runtime.writeText(join(runtime.homeRoot ?? '', action.input.path.slice(HOME_ROOT.length + 1)), action.input.content);
          else files.set(action.input.path, action.input.content);
          return { fileWrite: { path: action.input.path, bytes: action.input.content.length } };
        case 'readFile': {
          const content = action.path.startsWith(HOME_ROOT + '/')
            ? await runtime.readText(join(runtime.homeRoot ?? '', action.path.slice(HOME_ROOT.length + 1))).catch(() => '')
            : files.get(action.path) ?? '';
          return { fileRead: { content, bytes: content.length } };
        }
        case 'clipboardPaste': {
          state.pasted.push(action.input);
          const saved = action.input.kind === 'files' ? action.input.files.map((file) => ({ name: file.name, path: `Downloads/${file.name}` })) : null;
          return { clipboardPaste: saved === null ? { kind: 'image', path: 'Pictures/Pasted/fake.png' } : { kind: 'files', saved } };
        }
        case 'clipboardCopy': {
          const held = state.clipboard;
          if ('bytes' in held && held.bytes.byteLength > action.maxBytes) return { clipboardCopy: { kind: 'tooLarge', sizeBytes: held.bytes.byteLength } };
          return { clipboardCopy: held };
        }
        case 'navigate':
          return { navigate: { url: action.url, title: 'fake' } };
        case 'browser':
          return { browser: fakeBrowser(action.input) };
        case 'meet':
          return { meet: action.input.action === 'chat_send' ? { action: 'chat_send', sent: true } : action.input.action === 'chat_read' ? { action: 'chat_read', messages: [] } : action.input.action === 'audio_read' ? { action: 'audio_read', on: false, segments: [] } : { action: action.input.action, state: 'unknown', detail: 'fake computer has no Meet' } };
        case 'startProcess':
          return { process: { kind: 'started', snapshot: processes.start(agentId, action.input) } };
        case 'readProcess':
          return { process: { kind: 'read', output: processes.read(agentId, action.input) } };
        case 'writeProcess':
          return { process: { kind: 'write', result: processes.write(agentId, action.input) } };
        case 'stopProcess':
          return { process: { kind: 'stop', result: processes.stop(agentId, action.input) } };
        default:
          return {};
      }
    },

    async screenStream() {
      throw failed('the fake computer has no screen stream');
    },

    async withRuntime(_binding, _signal, fn, _options) {
      return fn(runtime);
    },

    // The double's files are the in-memory map the file actions use, so a copy sees what files.write wrote.
    async withTransfer(_binding, _agentId, _signal, fn) {
      const unsupported = (): never => {
        throw failed('the fake computer copies files only');
      };
      return fn({
        kindOf: async (path) => (files.has(path) ? 'file' : 'missing'),
        readFile: async (path) => new Uint8Array(Buffer.from(files.get(path) ?? '', 'utf8')),
        writeFile: async (path, bytes) => {
          files.set(path, Buffer.from(bytes).toString('utf8'));
        },
        readFolder: unsupported,
        writeFolder: unsupported,
      });
    },

    async environment() {
      return parseEnvironment({
        os: 'FakeOS 0.0 fakearch',
        platform: 'fake',
        user: 'agent',
        home: '/home/agent',
        workingDirectory: '/workspace',
        pathStyle: 'posix',
        kind: 'sandbox',
        ...opts.environment,
      });
    },

    async listeningPorts() {
      // The fake computer shares this host's loopback: the app range is probed for real (the uid cannot be known).
      const ports = Array.from({ length: SPACE_PORTS.last - SPACE_PORTS.first + 1 }, (_, index) => SPACE_PORTS.first + index);
      const open = await Promise.all(ports.map((port) => hostPortListens(port)));
      return ports.filter((_, index) => open[index]).map((port) => ({ port, uid: 0, loopback: true }));
    },

    async registerSpace(_binding, input) {
      if (!(await hostPortListens(input.port))) throw failed(`nothing is listening on port ${input.port}: start the app on its port (it must keep running), then publish again`);
      const { routesFile } = await fakeGateway(input.gatewayKey);
      let routes: Record<string, { port: number }> = {};
      try {
        routes = (JSON.parse(await readFile(routesFile, 'utf8')) as { routes: typeof routes }).routes;
      } catch {
        // first route
      }
      await mkdir(dirname(routesFile), { recursive: true });
      await writeFile(routesFile, JSON.stringify({ routes: { ...routes, [input.spaceId]: { port: input.port } } }), 'utf8');
    },

    async ensureSpaceGateway(_binding, gatewayKey) {
      await fakeGateway(gatewayKey);
    },

    async gatewayStream(_binding, _signal, options) {
      if (options?.passive === true && (paused || gateway === undefined)) throw failed('the computer is not running');
      if (paused) {
        state.connectCalls += 1;
        paused = false;
      }
      // The fake computer shares this host's loopback, so its "link" is a plain connection to the real gateway script.
      return connect({ port: Number(new URL((await fakeGateway()).url).port), host: '127.0.0.1' });
    },

    async metrics() {
      // Like the real providers: a paused computer has no live sample.
      if (paused) return null;
      return { memUsedMb: 512, memTotalMb: 1991, vcpu: 2, cpuPercent: 5, diskUsedGb: 3.2, diskTotalGb: 20 };
    },
  };
}

function screenshot(displayNo: number, handle: ScreenHandle | undefined): Screenshot {
  return { data: '', mimeType: 'image/png', width: handle?.width ?? 0, height: handle?.height ?? 0, displayNo };
}

/** The ref the fake browser treats as stale, so failure paths can be exercised without a live helper. */
export const STALE_REF = 'e404';
/** The key the fake computer offers for secure input (no private half exists; the fake never unseals). */
const FAKE_KEY_ID = 'fake0000fake0000';
const FAKE_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');

function fakeElements(refs: string[] | undefined): Array<{ ref?: string; rect: { x: number; y: number; width: number; height: number }; role: string; name: string }> {
  const rect = { x: 520, y: 400, width: 400, height: 48 };
  if (refs) return refs.map((ref) => ({ ref, rect, role: 'textbox', name: 'fake' }));
  return [{ rect, role: 'button', name: 'Continue' }];
}

/** Deterministic typed browser answers so route and executor tests never need a live helper. */
function fakeBrowser(input: BrowserInput): BrowserResult {
  const tab = 't1';
  switch (input.action) {
    case 'tabs':
      return { action: 'tabs', tabs: [{ tab, url: 'https://fake.invalid/', title: 'fake', active: true }] };
    case 'new_tab':
      return { action: 'new_tab', url: input.url ?? 'about:blank', title: 'fake', tab: 't2' };
    case 'snapshot':
      return { action: 'snapshot', url: 'https://fake.invalid/', title: 'fake', tab, nodes: [], crossOriginFrames: 0 };
    case 'scroll':
      return { action: 'scroll', url: 'https://fake.invalid/', title: 'fake', tab, scrolled: 100 };
    case 'get_text':
      return { action: 'get_text', url: 'https://fake.invalid/', title: 'fake', tab, text: '' };
    case 'navigate':
      return { action: 'navigate', url: input.url, title: 'fake', tab };
    case 'click':
      return { action: 'click', url: 'https://fake.invalid/', title: 'fake', tab, clicked: true };
    case 'type':
      return { action: 'type', url: 'https://fake.invalid/', title: 'fake', tab, typed: true };
    case 'bounds':
      return { action: 'bounds', url: 'https://fake.invalid/', title: 'fake', tab, elements: fakeElements(input.refs) };
    case 'attrs':
      return { action: 'attrs', url: 'https://fake.invalid/', title: 'fake', tab, fields: input.refs.map((ref) => ({ ref, tag: 'input', type: 'text' })) };
    case 'secure_key':
      return { action: 'secure_key', alg: 'X25519-HKDF-SHA256-AES256GCM', keyId: FAKE_KEY_ID, publicKey: FAKE_PUBLIC_KEY };
    case 'fill_secret':
      // A ref the fake calls stale fails like the real helper: truthfully, and without the value.
      if (input.ref === STALE_REF) throw failed(`browser fill_secret failed: unknown or stale ref '${input.ref}': take a fresh browser.snapshot`);
      return { action: 'fill_secret', url: 'https://fake.invalid/', title: 'fake', tab, filled: true };
    case 'dialog':
      return { action: 'dialog', url: 'https://fake.invalid/', title: 'fake', tab };
    case 'point':
      return { action: 'point', url: 'https://fake.invalid/', title: 'fake', tab };
    case 'notices':
      return { action: 'notices' };
  }
}
