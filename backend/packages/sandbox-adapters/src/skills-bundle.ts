/**
 * The platform skills as one versioned bundle (BACKEND §5.11b). The server's deployed copy of `sandbox-image/files/skills` is the
 * source of truth; a computer is brought to it by content version (`skills-sync.ts`), so a skill change reaches computers that
 * already exist, not only new ones built from a rebuilt template.
 *
 * The version is a hash over every file's relative path, executable bit and bytes, in byte order: deterministic across machines,
 * and any change to a file, a script's mode, an added or a removed file changes it.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface SkillsBundleFile {
  /** Relative to the skills directory, `/`-separated. */
  path: string;
  /** 0o755 for scripts (executable in the repository), 0o644 for the rest. */
  mode: number;
  content: Buffer;
}

export interface SkillsBundle {
  version: string;
  files: SkillsBundleFile[];
  /** The files as a ustar archive, owner root, for `tar -x` in the computer. */
  tar: Buffer;
}

/** Local noise that is never part of a skill. */
const SKIPPED = new Set(['.DS_Store', '__pycache__', 'node_modules', '.git']);
const BLOCK = 512;

async function walk(root: string, relative: string, out: SkillsBundleFile[]): Promise<void> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    if (SKIPPED.has(entry.name) || entry.name.endsWith('.pyc') || entry.name === '.version') continue;
    const path = relative === '' ? entry.name : relative + '/' + entry.name;
    if (entry.isDirectory()) await walk(root, path, out);
    else if (entry.isFile()) {
      const executable = ((await stat(join(root, path))).mode & 0o111) !== 0;
      out.push({ path, mode: executable ? 0o755 : 0o644, content: await readFile(join(root, path)) });
    }
  }
}

export function bundleVersion(files: readonly Pick<SkillsBundleFile, 'path' | 'mode' | 'content'>[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.mode.toString(8)}\0${createHash('sha256').update(file.content).digest('hex')}\n`);
  return hash.digest('hex');
}

const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, '0') + '\0';

/** One ustar header: the path is split into prefix and name when it is longer than 100 bytes. */
function header(file: SkillsBundleFile): Buffer {
  let name = file.path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const slashes = [...name].flatMap((char, index) => (char === '/' && index > 0 ? [index] : []));
    const at = slashes.find((index) => Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100);
    if (at === undefined) throw new Error(`skill file path too long for the bundle: ${file.path}`);
    prefix = name.slice(0, at);
    name = name.slice(at + 1);
  }
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100);
  block.write(octal(file.mode, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(file.content.length, 12), 124);
  block.write(octal(0, 12), 136);
  block.write('        ', 148);
  block.write('0', 156);
  block.write('ustar\0' + '00', 257);
  block.write('root', 265);
  block.write('root', 297);
  block.write(prefix, 345, 155);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}

export function buildTar(files: readonly SkillsBundleFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(header(file), file.content, Buffer.alloc((BLOCK - (file.content.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Read the directory into a bundle. A missing directory is an error: a deployment without its skills must say so. */
export async function readSkillsBundle(dir: string): Promise<SkillsBundle> {
  const files: SkillsBundleFile[] = [];
  await walk(dir, '', files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: bundleVersion(files), files, tar: buildTar(files) };
}

/** The bundle of a directory, read once and kept: skills change with a deploy, and a deploy restarts the process. */
export function createSkillsBundleSource(dir: string): () => Promise<SkillsBundle> {
  let cached: Promise<SkillsBundle> | undefined;
  return () => {
    cached ??= readSkillsBundle(dir).catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}
