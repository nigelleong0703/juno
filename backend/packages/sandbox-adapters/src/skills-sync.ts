/**
 * Bring a computer's `/opt/juno/skills` to the server's bundle (BACKEND §5.11b). The computer keeps the version of what it holds
 * in `<dir>/.version` (inside the directory, so it is swapped together with the files). Equal version: one small read, nothing
 * written. Different: the bundle is written as a tar next to the directory, unpacked into a sibling directory, given the modes the
 * image gives (root-owned, world-readable, not writable), then renamed over the old directory.
 */
import { failed } from './errors.js';
import type { SandboxRuntime } from './runtime.js';
import type { SkillsBundle } from './skills-bundle.js';
import { shq } from './shq.js';

/** Where the image installs the platform skills. */
export const SKILLS_DIR = '/opt/juno/skills';
const SYNC_TIMEOUT_MS = 60_000;

export interface SkillsSyncResult {
  /** False: the computer already had this version. */
  changed: boolean;
  /** The version the computer held before (absent: none, e.g. a template built before the sync existed). */
  previous?: string;
  /** The Python requirements differ from the ones the image's venv was built with: only a template rebuild installs them. */
  requirementsChanged: boolean;
}

export function installScript(dir: string, version: string): string {
  const [d, next, old, archive] = [dir, dir + '.new', dir + '.old', dir + '.incoming.tar'].map(shq);
  return [
    'set -e',
    `rm -rf ${next} ${old}`,
    `mkdir -p ${next}`,
    `tar -xf ${archive} -C ${next} --no-same-owner`,
    `rm -f ${archive}`,
    `printf %s ${shq(version)} > ${next}/.version`,
    `if [ "$(id -u)" = 0 ]; then chown -R root:root ${next}; fi`,
    `chmod -R a+rX,go-w ${next}`,
    `if [ -f ${d}/_lib/requirements.txt ] && ! cmp -s ${d}/_lib/requirements.txt ${next}/_lib/requirements.txt; then echo requirements-changed; fi`,
    `if [ -d ${d} ]; then mv ${d} ${old}; fi`,
    `mv ${next} ${d}`,
    `rm -rf ${old}`,
  ].join('\n');
}

export async function syncPlatformSkills(root: SandboxRuntime, bundle: SkillsBundle, options: { dir?: string; signal?: AbortSignal } = {}): Promise<SkillsSyncResult> {
  const dir = options.dir ?? SKILLS_DIR;
  const held = await root.readText(dir + '/.version').then((text) => text.trim(), () => undefined);
  const previous = held === undefined || held === '' ? {} : { previous: held };
  if (held === bundle.version) return { changed: false, ...previous, requirementsChanged: false };
  const archive = dir + '.incoming.tar';
  try {
    await root.writeBytes(archive, bundle.tar);
  } catch (error) {
    throw failed(`could not write the platform skills bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = await root.run(installScript(dir, bundle.version), { cwd: '/', timeoutMs: SYNC_TIMEOUT_MS, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  if (result.exitCode !== 0) throw failed(`could not install the platform skills: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return { changed: true, ...previous, requirementsChanged: result.stdout.includes('requirements-changed') };
}
