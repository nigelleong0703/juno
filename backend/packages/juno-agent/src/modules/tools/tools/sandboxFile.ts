/**
 * Reading a file out of the agent's sandbox for the tools that deliver it to the owner (send_file, artifact_publish).
 *
 * The bytes travel sandbox -> owner-scoped library row without ever entering the model context: one bounded
 * python3 call reads the file (the path is argv[1], so no content or path is interpolated into shell source),
 * the tool validates size and hash locally, and only metadata goes back to the model. Membership is revalidated
 * at execution time: the current conversation must list both the agent and
 * the owner, otherwise the tool fails before any sandbox read or store write.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '@agent-desktop/public-contracts';
import type { Store, ToolContext, ToolResult } from '../../../contracts/index.js';
import {
  defaultEnvironmentSource,
  requireComputerClient,
  requireEnvironment,
  type ComputerClientProvider,
  type ComputerEnvironmentSource,
} from '../computer/client.js';
import { isEnvAbsolute, resolveEnvPath } from '../computer/contract.js';
import { computerFailure } from '../computer/shared.js';
import { readStringArray, type RequesterContext } from './relationPolicy.js';

/** What reading from the computer needs of a tool call. */
export type SandboxCtx = Pick<ToolContext, 'agentId' | 'runId' | 'signal'>;

export interface SandboxOpts {
  computer?: ComputerClientProvider;
  environment?: ComputerEnvironmentSource;
}

const shellOutputSchema = z.object({
  contentBase64: z.string(),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().length(64),
});

export const MAX_FILE_BYTES = MAX_UPLOAD_BYTES;
const MAX_STDOUT_CHARS = 16 * 1024 * 1024;
export const SHELL_TIMEOUT_MS = 30_000;
const MAX_PATH_CHARS = 4096;

// The reader takes the path as argv[1] so no file content is ever
// interpolated into shell source. It uses only double-quoted Python strings
// so the whole program survives single-quote shell wrapping untouched.
export const READ_SCRIPT = [
  'import sys,json,base64,hashlib,os',
  'p=sys.argv[1]',
  'limit=' + String(MAX_FILE_BYTES),
  'n=os.path.getsize(p)',
  'if n>limit:',
  '    sys.stderr.write("file exceeds the 10MiB limit")',
  '    sys.exit(3)',
  'f=open(p,"rb")',
  'b=f.read()',
  'f.close()',
  'if len(b)!=n or len(b)>limit:',
  '    sys.stderr.write("file exceeds the 10MiB limit")',
  '    sys.exit(3)',
  'sys.stdout.write(json.dumps({"contentBase64":base64.b64encode(b).decode("ascii"),"sizeBytes":len(b),"sha256":hashlib.sha256(b).hexdigest()}))',
].join('\n');

export interface DecodedFile {
  bytes: Buffer;
  sizeBytes: number;
  sha256: string;
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason: unknown = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new Error('aborted');
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function invalidPath(path: string): string | undefined {
  if (path.length === 0 || path.length > MAX_PATH_CHARS) return 'Error: path must be 1..4096 characters.';
  if (path.includes('\0')) return 'Error: path must not contain NUL bytes.';
  if (path.trim().length === 0) return 'Error: path must not be blank.';
  return undefined;
}

/** Relative paths resolve against the run environment's working directory. */
export async function resolveToolPath(opts: SandboxOpts, ctx: SandboxCtx, path: string): Promise<string> {
  if (isEnvAbsolute(path)) return path;
  const source = opts.environment ?? defaultEnvironmentSource(opts.computer);
  const env = await requireEnvironment(source, { agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal });
  return resolveEnvPath(env, path);
}

export type SandboxRead =
  | { ok: true; value: DecodedFile }
  | { ok: false; error: ToolResult; missing: boolean };

/** Read and verify one file (size, canonical base64, sha256); `missing` tells an absent file from other failures. */
export async function readSandboxFile(opts: SandboxOpts, ctx: SandboxCtx, resolvedPath: string): Promise<SandboxRead> {
  let stdout: string;
  try {
    const client = requireComputerClient(opts.computer);
    const source = opts.environment ?? defaultEnvironmentSource(opts.computer);
    const env = await requireEnvironment(source, { agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal });
    const command = 'python3 -c ' + shellQuote(READ_SCRIPT) + ' ' + shellQuote(resolvedPath);
    const result = await client.runShell(ctx.agentId, { command, timeoutMs: SHELL_TIMEOUT_MS, cwd: env.workingDirectory }, ctx.signal);
    if (result.exitCode === 3) return { ok: false, missing: false, error: errorResult('Error: the file exceeds the 10MiB limit. Nothing was saved.') };
    if (result.exitCode !== 0) {
      const stderr = result.stderr.trim().slice(0, 300);
      const error = errorResult('Error: the sandbox could not read the file' + (stderr.length > 0 ? ': ' + stderr : '.') + ' Nothing was saved.');
      return { ok: false, missing: /No such file/i.test(result.stderr), error };
    }
    stdout = result.stdout;
  } catch (error) {
    return { ok: false, missing: false, error: computerFailure(error, ctx.signal) };
  }
  const decoded = decodeShellOutput(stdout);
  return decoded.ok ? { ok: true, value: decoded.value } : { ok: false, missing: false, error: errorResult(decoded.error) };
}

/** Run one shell command as the agent in its working directory. */
export async function runSandboxShell(
  opts: SandboxOpts,
  ctx: SandboxCtx,
  command: string,
  timeoutMs = SHELL_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const client = requireComputerClient(opts.computer);
  const source = opts.environment ?? defaultEnvironmentSource(opts.computer);
  const env = await requireEnvironment(source, { agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal });
  return client.runShell(ctx.agentId, { command, timeoutMs, cwd: env.workingDirectory }, ctx.signal);
}

/** The delivery gate: the conversation exists and lists both the agent and the owner. */
export async function validateCurrentConversation(
  store: Store,
  ctx: ToolContext,
  requester: RequesterContext,
): Promise<string | undefined> {
  let conversation: unknown;
  try {
    conversation = await store.get('conversations', ctx.conversationId);
  } catch {
    return 'Error: the current conversation record is unreadable; file delivery is denied.';
  }
  if (conversation === null) return 'Error: the current conversation does not exist; file delivery is denied.';
  const agentIds = readStringArray(conversation, 'agentIds') ?? [];
  if (!agentIds.includes(ctx.agentId)) {
    return 'Error: the current agent is not a member of this conversation; file delivery is denied.';
  }
  const memberIds = readStringArray(conversation, 'memberIds') ?? [];
  if (!memberIds.includes(requester.ownerId)) {
    return 'Error: the requester is not a member of this conversation; file delivery is denied.';
  }
  return undefined;
}

function decodeShellOutput(stdout: string): { ok: true; value: DecodedFile } | { ok: false; error: string } {
  if (stdout.length > MAX_STDOUT_CHARS) return { ok: false, error: 'Error: the file is too large to deliver (over the 10MiB limit).' };
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, error: 'Error: the sandbox returned an unreadable response; nothing was saved.' };
  }
  const parsed = shellOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'Error: the sandbox returned an unreadable response; nothing was saved.' };
  let bytes: Buffer;
  try {
    bytes = Buffer.from(parsed.data.contentBase64, 'base64');
  } catch {
    return { ok: false, error: 'Error: the sandbox returned invalid file data; nothing was saved.' };
  }
  if (bytes.toString('base64') !== parsed.data.contentBase64) {
    return { ok: false, error: 'Error: the sandbox returned invalid file data; nothing was saved.' };
  }
  if (bytes.length !== parsed.data.sizeBytes || bytes.length > MAX_FILE_BYTES) {
    return { ok: false, error: 'Error: the file is too large to deliver (over the 10MiB limit).' };
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== parsed.data.sha256) {
    return { ok: false, error: 'Error: the file failed its integrity check; nothing was saved.' };
  }
  return { ok: true, value: { bytes, sizeBytes: bytes.length, sha256: digest } };
}
