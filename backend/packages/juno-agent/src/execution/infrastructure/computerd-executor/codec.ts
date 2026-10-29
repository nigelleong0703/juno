/** Request bodies and response decoding for the computerd HTTP API. */

import {
  browserInputSchema,
  browserResultSchema,
  ComputerError,
  computerEnvironmentSchema,
  type BrowserInput,
  type BrowserResult,
  type ComputerCopyResult,
  type ComputerEnvironment,
  type FileContent,
  type FileWriteRequest,
  type FileWriteResult,
  type NavigateResult,
  type Point,
  type ProcessOutput,
  type ProcessReadInput,
  type ProcessSnapshot,
  type ProcessStartInput,
  type ProcessState,
  type ProcessStopResult,
  type ProcessWriteInput,
  type ProcessWriteResult,
  type RecordAudioInput,
  type RecordAudioResult,
  type Screenshot,
  type ScrollInput,
  type ShellInput,
  type ShellOutput,
} from '../../../modules/tools/index.js';
import { meetInputSchema, meetResultSchema, type MeetInput, type MeetResult } from '../../../ports/computer/index.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function point(input: Point): Record<string, unknown> {
  return { x: input.x, y: input.y, ...(input.button ? { button: input.button } : {}) };
}

export function scroll(input: ScrollInput): Record<string, unknown> {
  return { deltaY: input.deltaY, ...(input.deltaX === undefined ? {} : { deltaX: input.deltaX }) };
}

export function shell(input: ShellInput): Record<string, unknown> {
  return {
    command: input.command,
    timeoutMs: input.timeoutMs,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  };
}

export function fileWrite(input: FileWriteRequest): Record<string, unknown> {
  return { path: input.path, content: input.content };
}

/** Encode one typed browser action for the owner-scoped browser endpoint: the shared schema, as is. */
export function meetInput(input: MeetInput): Record<string, unknown> {
  return meetInputSchema.parse(input);
}

export function parseMeet(body: unknown): MeetResult {
  const parsed = meetResultSchema.safeParse(body);
  if (!parsed.success) throw new ComputerError('failed', 'computerd returned an invalid meet result');
  return parsed.data;
}

export function browserInput(input: BrowserInput): Record<string, unknown> {
  return browserInputSchema.parse(input);
}

export function recordAudioInput(input: RecordAudioInput): Record<string, unknown> {
  return input.action === 'start'
    ? { action: 'start', ...(input.maxDurationSeconds === undefined ? {} : { maxDurationSeconds: input.maxDurationSeconds }) }
    : { action: 'stop', recordingId: input.recordingId };
}

function requireString(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== 'string') throw new ComputerError('failed', `computerd returned no ${what}`);
  return value;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseScreenshot(body: unknown): Screenshot {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid screenshot');
  return {
    data: requireString(body, 'data', 'screenshot data'),
    mimeType: optionalString(body, 'mimeType') ?? 'image/png',
    width: optionalNumber(body, 'width') ?? 0,
    height: optionalNumber(body, 'height') ?? 0,
    displayNo: optionalNumber(body, 'displayNo') ?? 0,
  };
}

export function parseNavigate(body: unknown, fallbackUrl: string): NavigateResult {
  if (!isRecord(body)) return { url: fallbackUrl };
  const title = optionalString(body, 'title');
  return { url: optionalString(body, 'url') ?? fallbackUrl, ...(title === undefined ? {} : { title }) };
}

/** Decode one typed browser result; anything else-shaped fails instead of inventing a page. */
export function parseBrowser(body: unknown): BrowserResult {
  const parsed = browserResultSchema.safeParse(body);
  if (!parsed.success) throw new ComputerError('failed', 'computerd returned an invalid browser result');
  return parsed.data;
}

export function parseRecording(body: unknown): RecordAudioResult {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid recording result');
  const recordingId = requireString(body, 'recordingId', 'recording id');
  const path = requireString(body, 'path', 'recording path');
  const state = body['state'];
  if (state !== 'recording' && state !== 'stopped') throw new ComputerError('failed', 'computerd returned an invalid recording state');
  return { recordingId, path, state };
}

export function parseShell(body: unknown): ShellOutput {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid shell result');
  const exitCode = optionalNumber(body, 'exitCode');
  if (exitCode === undefined) throw new ComputerError('failed', 'computerd returned no shell exit code');
  return { stdout: optionalString(body, 'stdout') ?? '', stderr: optionalString(body, 'stderr') ?? '', exitCode };
}

export function parseCopy(body: unknown): ComputerCopyResult {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid copy result');
  const toPath = optionalString(body, 'toPath');
  const bytes = optionalNumber(body, 'bytes');
  const kind = body['kind'];
  if (toPath === undefined || bytes === undefined || (kind !== 'file' && kind !== 'folder')) throw new ComputerError('failed', 'computerd returned an invalid copy result');
  return { toPath, bytes, kind };
}

export function parseEnvironment(body: unknown): ComputerEnvironment {
  const parsed = computerEnvironmentSchema.safeParse(body);
  if (!parsed.success) throw new ComputerError('failed', 'computerd returned an invalid environment');
  return parsed.data;
}

export function parseFileRead(body: unknown): FileContent {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid file');
  const content = requireString(body, 'content', 'file content');
  return { content, bytes: optionalNumber(body, 'bytes') ?? content.length };
}

export function parseFileWrite(body: unknown, path: string): FileWriteResult {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid write result');
  return { path: optionalString(body, 'path') ?? path, bytes: optionalNumber(body, 'bytes') ?? 0 };
}

export function processStart(input: ProcessStartInput): Record<string, unknown> {
  return {
    command: input.command,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  };
}

export function processRead(input: ProcessReadInput): Record<string, unknown> {
  return {
    handle: input.handle,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    ...(input.stderrCursor === undefined ? {} : { stderrCursor: input.stderrCursor }),
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
  };
}

export function processWrite(input: ProcessWriteInput): Record<string, unknown> {
  return { handle: input.handle, data: input.data };
}

export function jevMcpStart(): Record<string, unknown> {
  return {};
}

export function jevMcpRead(input: ProcessReadInput): Record<string, unknown> {
  return processRead(input);
}

export function jevMcpWrite(input: ProcessWriteInput): Record<string, unknown> {
  return processWrite(input);
}

export function parseProcessSnapshot(body: unknown): ProcessSnapshot {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid process');
  return {
    handle: requireString(body, 'handle', 'process handle'),
    pid: optionalNumber(body, 'pid') ?? null,
    state: parseProcessState(body.state),
    exitCode: optionalNumber(body, 'exitCode') ?? null,
    startedAt: optionalString(body, 'startedAt') ?? '',
  };
}

export function parseProcessOutput(body: unknown): ProcessOutput {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid process read');
  return {
    handle: requireString(body, 'handle', 'process handle'),
    state: parseProcessState(body.state),
    exitCode: optionalNumber(body, 'exitCode') ?? null,
    output: optionalString(body, 'output') ?? '',
    stderr: optionalString(body, 'stderr') ?? '',
    cursor: optionalNumber(body, 'cursor') ?? 0,
    stderrCursor: optionalNumber(body, 'stderrCursor') ?? 0,
    totalBytes: optionalNumber(body, 'totalBytes') ?? 0,
    stderrTotalBytes: optionalNumber(body, 'stderrTotalBytes') ?? 0,
    truncated: body.truncated === true,
    stderrTruncated: body.stderrTruncated === true,
  };
}

export function parseProcessWrite(body: unknown, handle: string): ProcessWriteResult {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid process write');
  return { handle: optionalString(body, 'handle') ?? handle, bytes: optionalNumber(body, 'bytes') ?? 0 };
}

export function parseProcessStop(body: unknown, handle: string): ProcessStopResult {
  if (!isRecord(body)) throw new ComputerError('failed', 'computerd returned an invalid process stop');
  return { handle: optionalString(body, 'handle') ?? handle, state: parseProcessState(body.state), exitCode: optionalNumber(body, 'exitCode') ?? null };
}

/** An unknown state string is reported as `expired` rather than inventing a live process. */
function parseProcessState(value: unknown): ProcessState {
  if (value === 'running' || value === 'exited' || value === 'stopped' || value === 'expired') return value;
  return 'expired';
}
