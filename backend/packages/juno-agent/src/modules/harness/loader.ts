/**
 * The harness package loader (BACKEND §11.2, H1a): model-facing text is a set of versioned units, one Markdown file per unit under
 * `packages/juno-agent/harness/` (the path mirrors the id: `system.working` is `system/working.md`). Code reads text only through
 * `harnessText(id, vars)`; `vars` fill the `{{name}}` placeholders and nothing else (no logic, no conditionals).
 *
 * Which version a read uses: the version pinned for the running session (withHarnessVersion, set by buildContext from the frozen row),
 * else the active version. With no database the active version is the repository seed itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_IDS, type HarnessId } from './ids/index.js';

/** F frozen, N note, W wake and injected text, S background job, T tool description or parameter (harness-view.ts). */
export type HarnessPlacement = 'F' | 'N' | 'W' | 'S' | 'T';
export type HarnessOrigin = 'seed' | 'admin' | 'learned' | 'external';

export interface HarnessUnit {
  id: string;
  placement: HarnessPlacement;
  vars: readonly string[];
  /** The exact text: the file after its frontmatter, minus the one newline that ends the file. */
  body: string;
}

/** A compiled version: the raw file text of every unit (what is stored) and the parsed units. */
export interface HarnessVersion {
  /** `hv_<12 hex>` of the files. */
  id: string;
  files: Readonly<Record<string, string>>;
  units: ReadonlyMap<string, HarnessUnit>;
}

export class HarnessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

const PLACEHOLDER = /\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
const PLACEMENTS: readonly string[] = ['F', 'N', 'W', 'S', 'T'];

/** Parse one unit file. Throws HarnessError with the id when the file is not a valid unit. */
export function parseUnitFile(raw: string, expectedId?: string): HarnessUnit {
  const match = FRONTMATTER.exec(raw);
  if (match === null) throw new HarnessError(`harness unit ${expectedId ?? '?'}: no frontmatter`);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? '').split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) throw new HarnessError(`harness unit ${expectedId ?? '?'}: bad frontmatter line "${line}"`);
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const id = fields.get('id') ?? '';
  if (id === '' || (expectedId !== undefined && id !== expectedId)) throw new HarnessError(`harness unit ${expectedId ?? '?'}: id "${id}" does not match its path`);
  const placement = fields.get('placement') ?? '';
  if (!PLACEMENTS.includes(placement)) throw new HarnessError(`harness unit ${id}: placement "${placement}" is not F, N, W or S`);
  const varsField = fields.get('vars') ?? '';
  const listed = /^\[(.*)\]$/.exec(varsField);
  if (listed === null) throw new HarnessError(`harness unit ${id}: vars must be a [list], got "${varsField}"`);
  const vars = (listed[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name !== '');
  for (const name of vars) if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) throw new HarnessError(`harness unit ${id}: bad var name "${name}"`);
  let body = raw.slice(match[0].length);
  if (body.endsWith('\n')) body = body.slice(0, -1);
  if (body.trim() === '') throw new HarnessError(`harness unit ${id}: the text is empty`);
  const used = new Set([...body.matchAll(PLACEHOLDER)].map((found) => found[1] ?? ''));
  const opened = (body.match(/\{\{/g) ?? []).length;
  if (opened !== [...body.matchAll(PLACEHOLDER)].length) throw new HarnessError(`harness unit ${id}: a {{ is not a plain {{name}} placeholder`);
  const declared = new Set(vars);
  const missing = vars.filter((name) => !used.has(name));
  const extra = [...used].filter((name) => !declared.has(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new HarnessError(`harness unit ${id}: placeholders do not match vars (missing in text: ${missing.join(', ') || 'none'}; undeclared: ${extra.join(', ') || 'none'})`);
  }
  return { id, placement: placement as HarnessPlacement, vars, body };
}

/** The version id: sha256 over the sorted unit files (`hv_` and 12 hex characters). */
export function harnessVersionId(files: Readonly<Record<string, string>>): string {
  const hash = createHash('sha256');
  for (const id of Object.keys(files).sort()) hash.update(id + '\n' + (files[id] ?? '') + '\0');
  return 'hv_' + hash.digest('hex').slice(0, 12);
}

/** Validate a whole set of unit files against the ids the code reads: every id present, none extra, every unit valid. */
export function compileHarnessVersion(files: Readonly<Record<string, string>>): HarnessVersion {
  const problems: string[] = [];
  const units = new Map<string, HarnessUnit>();
  for (const id of Object.keys(files).sort()) {
    try {
      units.set(id, parseUnitFile(files[id] ?? '', id));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const id of HARNESS_IDS) if (!(id in files)) problems.push(`harness unit ${id} is referenced by code but missing`);
  // Tool units (`tool.*`) are referenced by the registry's slots, not by this list: the registry checks them at boot (tools/harness-view.ts).
  for (const id of Object.keys(files)) if (!id.startsWith('tool.') && !HARNESS_IDS.includes(id)) problems.push(`harness unit ${id} is not referenced by code`);
  if (problems.length > 0) throw new HarnessError('harness package is invalid:\n' + problems.join('\n'));
  return { id: harnessVersionId(files), files: { ...files }, units };
}

/** The seed directory: `packages/juno-agent/harness/` next to `src/`. */
export function harnessSeedDir(): string {
  return fileURLToPath(new URL('../../../harness/', import.meta.url));
}

/** Read every `.md` unit under a directory into {id: raw text}; the id is the path without `.md`, with `/` read as `.`. */
export function readHarnessFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      const id = relative(dir, full).slice(0, -'.md'.length).split(sep).join('.');
      files[id] = readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return files;
}

let seed: HarnessVersion | undefined;
/** The repository seed, compiled once. Throws when the seed directory is invalid (startup fails). */
export function harnessSeedVersion(): HarnessVersion {
  seed ??= compileHarnessVersion(readHarnessFiles(harnessSeedDir()));
  return seed;
}

let active: HarnessVersion | undefined;
/** The active version: set at boot from the store, else the repository seed (no database). */
export function activeHarnessVersion(): HarnessVersion {
  active ??= harnessSeedVersion();
  return active;
}
export function setActiveHarnessVersion(version: HarnessVersion): void {
  active = version;
}

const pinnedScope = new AsyncLocalStorage<HarnessVersion>();

/** Run `fn` (and everything it awaits) with `version` as the version every harnessText read uses. */
export function withHarnessVersion<T>(version: HarnessVersion, fn: () => T): T {
  return pinnedScope.run(version, fn);
}

/** The version a read uses right now: the pinned one inside withHarnessVersion, else the active one. */
export function currentHarnessVersion(): HarnessVersion {
  return pinnedScope.getStore() ?? activeHarnessVersion();
}

/** Render a unit of a version: `vars` must name exactly the unit's declared vars. */
export function renderHarnessUnit(version: HarnessVersion, id: string, vars: Readonly<Record<string, string>> = {}): string {
  const unit = version.units.get(id);
  if (unit === undefined) throw new HarnessError(`harness unit ${id} is not in version ${version.id}`);
  const given = Object.keys(vars).sort().join(',');
  const declared = [...unit.vars].sort().join(',');
  if (given !== declared) throw new HarnessError(`harness unit ${id}: vars given (${given}) do not match declared (${declared})`);
  return unit.body.replace(PLACEHOLDER, (_whole, name: string) => vars[name] ?? '');
}

/** The text of a unit in the version this read uses (see the module comment). */
export function harnessText(id: HarnessId, vars: Readonly<Record<string, string>> = {}): string {
  return renderHarnessUnit(currentHarnessVersion(), id, vars);
}
