import { describe, expect, it } from 'vitest';
import type { AgentHomeRow } from '../../../contracts/storage.js';
import { newRow } from '../mirror.js';
import { homePathError, isOwnDailyLog, isProtectedPath, isUserWritablePath, relativeToHome } from '../paths.js';
import { joinAgentsFile, splitAgentsFile } from '../render.js';
import { planSync } from '../sync.js';

const NOW = '2026-10-14T00:00:00.000Z';
const DAILY = 'memory/2026-10-14/agt-1.md';

function rowsOf(...rows: AgentHomeRow[]): Map<string, AgentHomeRow> {
  return new Map(rows.map((row) => [row.path, row]));
}
const file = (path: string, hash: string) => ({ path, hash, mtime: 1 });
const none = new Set<string>();

describe('home paths', () => {
  it('accepts relative paths only and refuses escapes', () => {
    expect(homePathError('agents/a/SOUL.md')).toBeNull();
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a\\b', './a', 'a\u0000b']) expect(homePathError(bad)).not.toBeNull();
  });

  it('resolves tool paths against /juno, normalizing ".." first', () => {
    expect(relativeToHome('/juno/USER.md')).toBe('USER.md');
    expect(relativeToHome('/other/../juno/MEMORY.md')).toBe('MEMORY.md');
    expect(relativeToHome('/juno/../secrets')).toBeUndefined();
    expect(relativeToHome('/home/agent/juno/a.md')).toBeUndefined();
  });

  it('protects everything but daily logs, and lets an agent write only its own', () => {
    expect(isProtectedPath('USER.md')).toBe(true);
    expect(isProtectedPath('memory/bank/preferences.md')).toBe(true);
    expect(isProtectedPath(DAILY)).toBe(false);
    expect(isOwnDailyLog(DAILY, 'agt-1')).toBe(true);
    expect(isOwnDailyLog(DAILY, 'agt-2')).toBe(false);
  });

  it('lets the user write their files and only the creator\'s agent files', () => {
    const mine = new Set(['agt-1']);
    expect(isUserWritablePath('USER.md', mine)).toBe(true);
    expect(isUserWritablePath('agents/agt-1/SOUL.md', mine)).toBe(true);
    expect(isUserWritablePath('agents/agt-2/SOUL.md', mine)).toBe(false);
    expect(isUserWritablePath('agents/agt-1/skills/x/SKILL.md', mine)).toBe(false);
    expect(isUserWritablePath('docs/memory.md', mine)).toBe(false);
  });

  it('splits and rejoins AGENTS.md around its reach-out section', () => {
    const text = joinAgentsFile('Do the work.', 'Only urgent things.');
    expect(splitAgentsFile(text)).toEqual({ instructions: 'Do the work.', reachOut: 'Only urgent things.' });
    expect(splitAgentsFile('Just work.')).toEqual({ instructions: 'Just work.', reachOut: '' });
  });
});

describe('sync rules (BACKEND §5.2)', () => {
  const soul = newRow('o', 'agents/agt-1/SOUL.md', 'be brief', 'user', NOW);

  it('rule 1: pending rows are written and their flag cleared', () => {
    const pending = newRow('o', 'USER.md', 'hi', 'user', NOW, true);
    const plan = planSync({ snapshot: { synced: true, files: [] }, rows: rowsOf(pending), platformUpdated: none, platformRemoved: none });
    expect(plan.write).toEqual(['USER.md']);
    expect(plan.clearPending).toEqual(['USER.md']);
    expect(plan.reverted).toEqual([]);
  });

  it('rule 2: a computer without the marker gets the whole mirror back, then the marker', () => {
    const plan = planSync({ snapshot: { synced: false, files: [] }, rows: rowsOf(soul, newRow('o', DAILY, 'x', 'agent', NOW)), platformUpdated: none, platformRemoved: none });
    expect(plan.write.sort()).toEqual([DAILY, soul.path].sort());
    expect(plan.marker).toBe(true);
  });

  it('rule 2 does not overwrite files the storage already holds', () => {
    const plan = planSync({ snapshot: { synced: false, files: [file(DAILY, 'on the storage')] }, rows: rowsOf(soul, newRow('o', DAILY, 'x', 'agent', NOW)), platformUpdated: none, platformRemoved: none });
    expect(plan.write).toEqual([soul.path]);
    expect(plan.marker).toBe(true);
  });

  it('rule 3: the computer wins for daily logs; a log missing there leaves the mirror', () => {
    const known = newRow('o', DAILY, 'old', 'agent', NOW);
    const plan = planSync({
      snapshot: { synced: true, files: [file(DAILY, 'changed'), file('memory/2026-10-14/agt-2.md', 'new')] },
      rows: rowsOf(known, newRow('o', 'memory/2026-10-13/agt-1.md', 'gone', 'agent', NOW)), platformUpdated: none, platformRemoved: none,
    });
    expect(plan.pull.sort()).toEqual([DAILY, 'memory/2026-10-14/agt-2.md']);
    expect(plan.dropRows).toEqual(['memory/2026-10-13/agt-1.md']);
    expect(plan.reverted).toEqual([]);
  });

  it('rule 4: a protected file changed, deleted or added behind the platform is restored and audited', () => {
    const plan = planSync({
      snapshot: { synced: true, files: [file(soul.path, 'tampered'), file('MEMORY.md', 'planted')] },
      rows: rowsOf(soul, newRow('o', 'USER.md', 'about me', 'user', NOW)), platformUpdated: none, platformRemoved: none,
    });
    expect(plan.write.sort()).toEqual(['USER.md', soul.path]);
    expect(plan.remove).toEqual(['MEMORY.md']);
    expect(plan.reverted.map((entry) => entry.path).sort()).toEqual(['MEMORY.md', 'USER.md', soul.path]);
  });

  it('a platform update of its own row is not tampering, and a removed one leaves the computer silently', () => {
    const skill = newRow('o', 'agents/agt-1/skills/a/SKILL.md', 'v2', 'platform', NOW);
    const plan = planSync({
      snapshot: { synced: true, files: [file(skill.path, 'v1'), file('agents/agt-1/skills/b/SKILL.md', 'b')] },
      rows: rowsOf(skill), platformUpdated: new Set([skill.path]), platformRemoved: new Set(['agents/agt-1/skills/b/SKILL.md']),
    });
    expect(plan.write).toEqual([skill.path]);
    expect(plan.remove).toEqual(['agents/agt-1/skills/b/SKILL.md']);
    expect(plan.reverted).toEqual([]);
  });
});
