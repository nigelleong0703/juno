/**
 * files.search — bounded grep/find on this agent's bound computer.
 *
 * The command runs through the injected ComputerClient's runShell in the binding working directory
 * (ctx.agentId selects this agent's own screen); no host shell is ever spawned. Every path, pattern
 * and glob is single-quoted so model input cannot break out of its argument, and output is bounded
 * by a line ceiling with a continuation hint instead of a silent dump.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import {
  defaultEnvironmentSource,
  requireComputerClient,
  requireEnvironment,
} from '../computer/client.js';
import { computerFailure, ON_PROPERTY, ON_SCHEMA } from '../computer/shared.js';
import { DEFAULT_SEARCH_RESULTS, MAX_SEARCH_BYTES, MAX_SEARCH_RESULTS, shellQuote, truncateBytes } from './codingHelpers.js';
import type { FileToolOptions } from './codingPath.js';
import { refuseHomeRead, refuseServerReports } from './homeGuard.js';
import { resolveEnvPath } from '../computer/contract.js';

/** Same ceiling the shell tool uses; a search is short-lived and never sleeps. */
const SEARCH_TIMEOUT_MS = 30_000;

const searchSchema = z.object({
  query: z.string().min(1),
  path: z.string().min(1).optional(),
  mode: z.enum(['content', 'name']).optional(),
  glob: z.string().min(1).optional(),
  maxResults: z.number().int().min(1).optional(),
  on: ON_SCHEMA,
});

export function createFileSearchTool(opts: FileToolOptions): Tool {
  return {
    name: 'files.search',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '' },
        path: { type: 'string', description: '' },
        mode: { type: 'string', enum: ['content', 'name'], description: '' },
        glob: { type: 'string', description: '' },
        maxResults: { type: 'integer', minimum: 1, description: '' },
        ...ON_PROPERTY,
      },
      required: ['query'],
      additionalProperties: false,
    },
    // A read-only search is safe to redo after an interruption.
    replay: 'safe',
    sideEffect: false,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = searchSchema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        const source = opts.environment ?? defaultEnvironmentSource(opts.computer);
        const env = await requireEnvironment(source, { agentId: ctx.agentId, runId: ctx.runId, signal: ctx.signal, ...(parsed.on === undefined ? {} : { on: parsed.on }) });
        const mode = parsed.mode ?? 'content';
        const limit = Math.min(parsed.maxResults ?? DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
        // `~/` is the user's home (the shell would see a quoted literal), and no search may look into another agent's home files or, with other people present, the private memory.
        const given = parsed.path ?? '.';
        const path = given.startsWith('~') ? resolveEnvPath(env, given) : given;
        const root = resolveEnvPath(env, path);
        const refused = refuseServerReports(root) ?? (parsed.on === 'mac' ? undefined : await refuseHomeRead(opts, ctx, root));
        if (refused !== undefined) return refused;
        const command = buildSearchCommand(mode, parsed.query, path, parsed.glob, limit);
        const output = await client.runShell(ctx.agentId, { command, timeoutMs: SEARCH_TIMEOUT_MS, cwd: env.workingDirectory }, ctx.signal, parsed.on);
        const lines = splitLines(output.stdout);
        if (isSearchFailure(mode, output.exitCode)) return searchError(path, mode, command, output.exitCode, output.stderr);
        const bounded = truncateBytes(lines.slice(0, limit).join('\n'), MAX_SEARCH_BYTES);
        const truncated = lines.length > limit || bounded.truncated;
        const details = { path, mode, glob: parsed.glob, query: parsed.query, matches: Math.min(lines.length, limit), limit, truncated, exitCode: output.exitCode };
        if (bounded.text === '') return { content: [{ type: 'text', text: `No matches for ${JSON.stringify(parsed.query)} under ${path}` }], details };
        const content: ToolResult['content'] = [{ type: 'text', text: bounded.text }];
        if (truncated) content.push({ type: 'text', text: `[truncated: showing first ${details.matches} of ${lines.length} matches; narrow path/glob or raise maxResults]` });
        return { content, details };
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}

/** `grep` exits 1 on no match and 2 on a real error; `find` exits nonzero only on error. */
function isSearchFailure(mode: 'content' | 'name', exitCode: number): boolean {
  return mode === 'content' ? exitCode > 1 : exitCode !== 0;
}

function searchError(path: string, mode: string, command: string, exitCode: number, stderr: string): ToolResult {
  const detail = stderr.trim() || `command exited with code ${exitCode}`;
  return { content: [{ type: 'text', text: `Search of ${path} failed: ${detail}` }], isError: true, details: { path, mode, command, exitCode } };
}

function splitLines(stdout: string): string[] {
  const trimmed = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  return trimmed === '' ? [] : trimmed.split('\n');
}

/**
 * Build the search as a POSIX shell program.
 *
 * The producer (grep/find) writes to a temp file and its exit status is captured BEFORE the bounded
 * `head`, so the redirect can never mask a failure the way a `producer | head` pipeline would (there
 * `head`'s 0 becomes the pipeline status). Because the producer writes to a file and not a pipe, a
 * large result-set cannot raise SIGPIPE against it, so bounding output can never turn a successful
 * search into a spurious failure. `pipefail` is deliberately not used: it is not portable, and the
 * fix must hold on a plain POSIX `sh`. The status the caller sees is grep's own (0 match, 1 no match,
 * 2 error) or find's (0 ok, nonzero error). stdout is the first `limit + 1` lines (one extra so the
 * caller can detect truncation); stderr passes through unchanged; the temp files are always removed.
 */
function buildSearchCommand(mode: 'content' | 'name', query: string, path: string, glob: string | undefined, limit: number): string {
  const producer = mode === 'name' ? findProducer(query, path, glob) : grepProducer(query, path, glob);
  const out = `/tmp/vomu-search-${token()}.out`;
  const err = `/tmp/vomu-search-${token()}.err`;
  return `O=${out}; E=${err}; ${producer} > "$O" 2> "$E"; rc=$?; head -n ${limit + 1} "$O"; cat "$E" >&2; rm -f "$O" "$E"; exit $rc`;
}

function grepProducer(query: string, path: string, glob: string | undefined): string {
  const include = glob === undefined ? '' : ` --include=${shellQuote(glob)}`;
  return `grep -rnI --exclude-dir=.git${include} -e ${shellQuote(query)} -- ${shellQuote(path)}`;
}

function findProducer(query: string, path: string, glob: string | undefined): string {
  const pattern = glob ?? query;
  const target = path.startsWith('-') ? './' + path : path;
  return `find ${shellQuote(target)} -type f -name ${shellQuote(pattern)}`;
}

/** A per-invocation token so concurrent searches never share a temp file. */
function token(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}
