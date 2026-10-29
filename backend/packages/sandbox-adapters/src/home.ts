/**
 * The user's `/juno` home on one sandbox runtime (BACKEND §5.2): snapshot, read, write, delete. Plain POSIX shell plus
 * the runtime's file calls, so it behaves the same on E2B, local Docker and the test double. The caller runs it as root
 * (computerd passes `user: 'root'`); a written file gets the owner and mode of `homeOwnership` (BACKEND §7.9). Paths are validated before
 * they reach the shell, and the shell re-checks that nothing resolves outside the home through a symlink.
 */
import { createHash } from 'node:crypto';
import type { HomeContent, HomeSnapshot, HomeTextFormat } from 'juno-agent/computer';
import { HOME_ROOT, SYNC_MARKER, homeHash, homePathError, isDailyLog } from 'juno-agent/modules/home/paths';
import { failed, homeConflict, notAllowed } from './errors.js';
import type { SandboxRuntime } from './runtime.js';
import { homeAgentOf } from './isolation-user.js';
import { ownershipScript, userScript } from './isolation.js';
import { shq } from './screen-boot.js';

const TIMEOUT_MS = 30_000;
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Exit code the scripts use for "resolves outside /juno". */
const ESCAPE = 3;

const HASH_FN = 'hs() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d" " -f1; }';
const MTIME_FN = 'mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }';

/** Where the image keeps the platform skills (BACKEND 5.1): read-only, each a SKILL.md with `name` and `description` frontmatter. */
export const PLATFORM_SKILLS_ROOT = '/opt/juno/skills';
const MAX_PLATFORM_SKILLS = 100;

/** The platform skill tools that print a document's text (`<tool> text FILE`), run with the skills venv's Python. */
const TEXT_TOOLS: Record<HomeTextFormat, string> = {
  pdf: PLATFORM_SKILLS_ROOT + '/pdf/pdf_tool.py',
  docx: PLATFORM_SKILLS_ROOT + '/docx/docx_tool.py',
};
const SKILLS_PYTHON = '/opt/juno/venv/bin/python';
const EXTRACT_TIMEOUT_S = 25;
/** Bytes of extracted text returned; the caller decides what it can show. */
export const MAX_EXTRACTED_BYTES = 256 * 1024;

/** awk over one SKILL.md: prints `P<TAB>path<TAB>name<TAB>description` from its single-line frontmatter. */
const PLATFORM_SKILL_AWK =
  'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} ' +
  '/^name:/{n=$0;sub(/^name:[ \\t]*/,"",n);gsub(/^"|"$/,"",n)} /^description:/{d=$0;sub(/^description:[ \\t]*/,"",d);gsub(/^"|"$/,"",d)} ' +
  'END{if(n!=""){gsub(/\\t/," ",d);printf "P\\t%s\\t%s\\t%s\\n",FILENAME,n,d}}';

/** Shell that prints `<path>\t<hash>\t<mtime>` for every file the sync looks at, after an `S 0|1` marker line. */
export function snapshotScript(agentId: string, root: string = HOME_ROOT): string {
  const a = agentId;
  return [
    'J=' + shq(root),
    HASH_FN,
    MTIME_FN,
    '[ -f "$J/' + SYNC_MARKER + '" ] && echo "S 1" || echo "S 0"',
    '{',
    '  for f in USER.md PROACTIVE_PREFERENCES.md MEMORY.md ALIGNMENT_SYNTHESIS.md; do [ -f "$J/$f" ] && echo "$J/$f"; done',
    '  for f in IDENTITY SOUL AGENTS TOOLS; do [ -f "$J/agents/' + a + '/$f.md" ] && echo "$J/agents/' + a + '/$f.md"; done',
    '  find "$J/memory" "$J/dreams" "$J/people" "$J/groups" "$J/self_improvement" "$J/docs" "$J/agents/' + a + '/skills" -type f 2>/dev/null',
    '} | while IFS= read -r f; do printf "F\\t%s\\t%s\\t%s\\n" "${f#$J/}" "$(hs "$f")" "$(mt "$f")"; done',
    'for f in ' + PLATFORM_SKILLS_ROOT + '/*/SKILL.md; do [ -f "$f" ] && awk ' + shq(PLATFORM_SKILL_AWK) + ' "$f"; done',
    'true',
  ].join('\n');
}

export function parseSnapshot(stdout: string): HomeSnapshot {
  const files: HomeSnapshot['files'] = [];
  const platformSkills: NonNullable<HomeSnapshot['platformSkills']> = [];
  let synced = false;
  for (const line of stdout.split('\n')) {
    if (line === 'S 1') synced = true;
    const [tag, path, hash, mtime] = line.split('\t');
    if (tag === 'P') {
      // `P <path> <name> <description>`: the columns are reused, so `hash` is the name and `mtime` the description here.
      if (path !== undefined && hash !== undefined && platformSkills.length < MAX_PLATFORM_SKILLS) platformSkills.push({ path, name: hash, description: mtime ?? '' });
      continue;
    }
    if (tag !== 'F' || path === undefined || hash === undefined || homePathError(path) !== null || !/^[0-9a-f]{64}$/.test(hash)) continue;
    files.push({ path, hash, mtime: Number(mtime) || 0 });
  }
  return { synced, files, platformSkills };
}

/**
 * Prepares `$J/<path>` for a write or delete: refuses when its directory resolves outside the home, drops a symlink
 * standing in for the file, and prints `H <home>` then `E <hash>` when the file exists.
 */
function prepareScript(path: string, createDir: boolean, root: string): string {
  const rel = shq(path);
  return [
    'J=' + shq(root),
    HASH_FN,
    'mkdir -p "$J"',
    'JR="$(cd "$J" && pwd -P)"',
    'T="$J/"' + rel,
    'D="$(dirname "$T")"',
    createDir ? 'mkdir -p "$D"' : '[ -d "$D" ] || exit 0',
    'DR="$(cd "$D" && pwd -P)"',
    'case "$DR/" in "$JR"/*) ;; *) exit ' + String(ESCAPE) + ' ;; esac',
    '[ -L "$T" ] && rm -f "$T"',
    '[ -f "$T" ] && echo "E $(hs "$T")"',
    'true',
  ].join('\n');
}

interface Prepared {
  /** Hash of the existing file, if any. */
  existing: string | undefined;
}

export function createSandboxHome(runtime: SandboxRuntime) {
  const root = runtime.homeRoot ?? HOME_ROOT;
  const run = async (script: string) => {
    const result = await runtime.run(script, { timeoutMs: TIMEOUT_MS });
    if (result.exitCode === ESCAPE) throw notAllowed('path resolves outside /juno');
    if (result.exitCode !== 0) throw failed('home command failed: ' + (result.stderr || result.stdout).trim().slice(0, 300));
    return result.stdout;
  };

  async function prepare(path: string, createDir: boolean): Promise<Prepared> {
    const bad = homePathError(path);
    if (bad !== null) throw notAllowed(bad);
    const out = (await run(prepareScript(path, createDir, root))).split('\n');
    return { existing: out.find((line) => line.startsWith('E '))?.slice(2).trim() };
  }

  /**
   * The §7.9 owner and mode for a file and the directories above it (a daily log belongs to its agent's Linux user,
   * everything else to root). The test double has no agent users, so there it only makes the file readable.
   */
  const applyOwnership = async (path: string) => {
    if (runtime.homeRoot !== undefined) {
      await run('chmod 0644 ' + shq(root + '/' + path));
      return;
    }
    const agent = homeAgentOf(path);
    await run([...(agent === undefined ? [] : [userScript(agent)]), ownershipScript(path)].join('\n'));
  };

  return {
    async snapshot(agentId: string): Promise<HomeSnapshot> {
      if (!AGENT_ID.test(agentId)) throw notAllowed('invalid agent id');
      return parseSnapshot(await run(snapshotScript(agentId, root)));
    },

    async read(path: string): Promise<HomeContent | null> {
      const { existing } = await prepare(path, false);
      if (existing === undefined) return null;
      const content = await runtime.readText(root + '/' + path);
      return { content, hash: homeHash(content) };
    },

    async write(path: string, content: string, expectedHash?: string): Promise<{ hash: string }> {
      const { existing } = await prepare(path, true);
      if (expectedHash !== undefined && existing !== expectedHash) throw homeConflict(path + ' changed since it was read');
      await runtime.writeText(root + '/' + path, content);
      await applyOwnership(path);
      return { hash: homeHash(content) };
    },

    /**
     * Puts uploaded bytes at `path` (creating parents) with the §7.9 owner and mode of the shared user layer, so every agent can
     * read it and none can change it. A file that already holds exactly these bytes is not written again.
     */
    async put(path: string, bytes: Uint8Array): Promise<{ hash: string; written: boolean }> {
      const { existing } = await prepare(path, true);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const written = existing !== hash;
      if (written) await runtime.writeBytes(root + '/' + path, bytes);
      await applyOwnership(path);
      return { hash, written };
    },

    /** The text of a PDF or DOCX in the home, from the platform skill tool, as root with a time limit; at most MAX_EXTRACTED_BYTES. */
    async extractText(path: string, format: HomeTextFormat): Promise<{ text: string; truncated: boolean }> {
      const { existing } = await prepare(path, false);
      if (existing === undefined) throw failed(path + ' does not exist');
      const command = `timeout ${String(EXTRACT_TIMEOUT_S)} ${SKILLS_PYTHON} ${TEXT_TOOLS[format]} text ${shq(root + '/' + path)} | head -c ${String(MAX_EXTRACTED_BYTES)}`;
      const result = await runtime.run(command, { timeoutMs: (EXTRACT_TIMEOUT_S + 5) * 1000 });
      if (result.stdout === '') throw failed('could not read the ' + format + ': ' + (result.stderr.trim().slice(0, 300) || 'no text'));
      return { text: result.stdout, truncated: Buffer.byteLength(result.stdout) >= MAX_EXTRACTED_BYTES };
    },

    /** Creates an empty daily log when it is missing so the agent can append to it; an existing file keeps its content. */
    async ensure(path: string): Promise<void> {
      if (!isDailyLog(path)) throw notAllowed('only daily logs are created for the agent');
      const { existing } = await prepare(path, true);
      if (existing === undefined) await runtime.writeText(root + '/' + path, '');
      await applyOwnership(path);
    },

    async delete(path: string, expectedHash?: string): Promise<void> {
      const { existing } = await prepare(path, false);
      if (existing === undefined) return;
      if (expectedHash !== undefined && existing !== expectedHash) throw homeConflict(path + ' changed since it was read');
      await run('rm -f ' + shq(root + '/' + path));
    },
  };
}

export type SandboxHome = ReturnType<typeof createSandboxHome>;
