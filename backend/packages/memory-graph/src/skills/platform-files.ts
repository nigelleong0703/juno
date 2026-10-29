/** The platform skills' source files: `<dir>/<skill>/SKILL.md` as the sandbox image ships them (BACKEND §5.1). They are only the seed of the platform_skills rows. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlatformSkillFile, type PlatformSkillFile, type PlatformSkillsService, type SeedReport } from './platform.js';

/** `PLATFORM_SKILLS_DIR`, else the repository's copy of what the image installs under /opt/juno/skills. */
export function platformSkillsDir(env: Record<string, string | undefined> = process.env): string {
  const set = env['PLATFORM_SKILLS_DIR']?.trim();
  return set !== undefined && set !== '' ? set : fileURLToPath(new URL('../../../sandbox-image/files/skills', import.meta.url));
}

/** Every skill directory with a non-empty SKILL.md (directories starting with `_` hold shared libraries, not skills). */
export async function readPlatformSkillFiles(dir: string): Promise<PlatformSkillFile[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files: PlatformSkillFile[] = [];
  for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith('_')).sort((a, b) => a.name.localeCompare(b.name))) {
    const content = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8').catch(() => undefined);
    const parsed = content === undefined ? null : parsePlatformSkillFile(entry.name, content);
    if (parsed !== null) files.push(parsed);
  }
  return files;
}

/** Boot-time seed: read the image's files and make the rows match. A missing folder seeds nothing (skills are then read from the computer, as before). */
export async function seedPlatformSkills(service: PlatformSkillsService, dir: string = platformSkillsDir()): Promise<SeedReport> {
  return service.seed(await readPlatformSkillFiles(dir));
}
