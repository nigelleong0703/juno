/**
 * The durable computer binding: which E2B sandbox holds this owner's screens. Losing it would
 * create a second VM, so this file is the single source of truth and it fails fast:
 *
 *  - a seed binding (e.g. \`E2B_SANDBOX_ID\` for an existing sandbox) is PERSISTED on first open, so
 *    dropping the env var on a later restart still reuses the same VM;
 *  - a write is atomic (temp file + rename) and a write/read failure throws instead of silently
 *    falling back to "no binding" (which would boot a new VM);
 *  - a missing file is the only benign case (first run).
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { e2bBindingSchema, type E2bBinding } from '@agent-desktop/contracts';
import { failed } from '@agent-desktop/sandbox-adapters';

export interface ComputerStateStore {
  get(): E2bBinding | null;
  set(binding: E2bBinding): void;
  /**
   * Retire the binding: it is copied to `bindings-archive/` next to the binding file (with when and why), then forgotten, so
   * the next use creates a fresh computer. Never a silent delete; returns the archive path ('' when there is no file).
   */
  archive(reason: string): string;
}

/** Directory (next to the binding file) holding every binding the platform retired. */
export const ARCHIVE_DIR = 'bindings-archive';

export function createComputerStateStore(file: string, seed: E2bBinding | null): ComputerStateStore {
  const disk = file ? readBinding(file) : null;
  let binding: E2bBinding | null = disk ?? seed;
  if (file && !disk && seed) writeBinding(file, seed);

  return {
    get: () => binding,
    set(next) {
      if (file) writeBinding(file, next);
      binding = next;
    },
    archive(reason) {
      if (!binding) return '';
      const retired = binding;
      let path = '';
      if (file) {
        const dir = join(dirname(file), ARCHIVE_DIR);
        const at = new Date().toISOString();
        path = join(dir, `${at.replace(/[:.]/g, '-')}-${retired.sandboxId.slice(0, 12)}.json`);
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(path, JSON.stringify({ archivedAt: at, reason, binding: retired }, null, 2));
          rmSync(file, { force: true });
        } catch (error) {
          throw failed(`could not archive the sandbox binding ${file}: ${message(error)}`);
        }
      }
      binding = null;
      return path;
    },
  };
}

export function readBindingFile(file: string): E2bBinding | null {
  return file ? readBinding(file) : null;
}

function readBinding(file: string): E2bBinding | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return null;
    throw failed(`could not read the sandbox binding ${file}: ${message(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw failed(`sandbox binding ${file} is corrupt; refusing to start with a possibly different VM`);
  }
  const result = e2bBindingSchema.safeParse(parsed);
  if (!result.success) throw failed(`sandbox binding ${file} is invalid; refusing to start`);
  return result.data;
}

function writeBinding(file: string, binding: E2bBinding): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(binding, null, 2));
    renameSync(temp, file);
  } catch (error) {
    throw failed(`could not persist the sandbox binding to ${file}: ${message(error)}`);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
