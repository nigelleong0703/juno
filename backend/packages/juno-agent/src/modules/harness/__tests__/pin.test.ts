/**
 * Harness versions (BACKEND §11.2): a session reads the version it is pinned to, a new session reads the active one, and a version that
 * does not match the code's ids or placeholders is refused.
 */
import { describe, expect, it } from 'vitest';
import { compileHarnessVersion, harnessSeedVersion, harnessText, HarnessError, parseUnitFile, withHarnessVersion } from '../loader.js';
import { HarnessPins, logPinnedUpgrades, type HarnessVersionRow, type HarnessVersionStore } from '../store.js';
import { repinSystemRow } from '../pin.js';
import { systemMessage, metaOf } from '../../../execution/brain/context-notes.js';
import { createMemoryStore } from '../../../testing/store.js';

const ALTERED_ID = 'persona.default';

/** The seed with one unit's body changed: a second version that differs only in that text. */
function alteredVersion() {
  const files: Record<string, string> = { ...harnessSeedVersion().files };
  files[ALTERED_ID] = (files[ALTERED_ID] ?? '').replace(/\n$/, ' [altered]\n');
  return compileHarnessVersion(files);
}

function memoryVersionStore(versions: ReturnType<typeof alteredVersion>[]): HarnessVersionStore {
  const rows = new Map<string, HarnessVersionRow>(versions.map((version) => [version.id, {
    id: version.id, parentId: null, files: { ...version.files }, origin: 'seed', status: 'retired', note: '', createdAt: '2026-10-26T00:00:00.000Z',
  }]));
  return {
    async row(id) { return rows.get(id); },
    async active() { return undefined; },
    async pinnedVersions() { return [...rows.keys()].map((id) => ({ id, sessions: 1 })); },
    async seedActive() { throw new Error('not used'); },
  };
}

const OLD_ID = 'hv_old000000000';
const DROPPED_ID = 'wake.dropped_by_code';
const NEW_UNITS = ['wake.automatic.nobody_waiting', 'artifacts.document'];

/** A unit the seed declares with vars, and the same unit as an older version wrote it: other vars, other text. */
function changedVarsUnit(): { id: string; oldFile: string } {
  const seed = harnessSeedVersion();
  const unit = [...seed.units.values()].find((candidate) => candidate.vars.length > 0 && candidate.placement === 'W');
  if (unit === undefined) throw new Error('the seed has no wake unit with vars');
  return { id: unit.id, oldFile: `---\nid: ${unit.id}\nplacement: ${unit.placement}\nvars: []\n---\nOLD TEXT WITHOUT VARS\n` };
}

/** The incident's shape: an old row = the seed minus two units the code added since, one unit with other vars, and one unit the code dropped. */
function oldRowFiles(): Record<string, string> {
  const files: Record<string, string> = { ...harnessSeedVersion().files };
  for (const id of NEW_UNITS) delete files[id];
  const changed = changedVarsUnit();
  files[changed.id] = changed.oldFile;
  files[DROPPED_ID] = `---\nid: ${DROPPED_ID}\nplacement: W\nvars: []\n---\nno longer read\n`;
  return files;
}

function storeWith(files: Record<string, string>): HarnessVersionStore {
  const row: HarnessVersionRow = { id: OLD_ID, parentId: null, files, origin: 'seed', status: 'retired', note: '', createdAt: '2026-10-26T00:00:00.000Z' };
  return {
    async row(id) { return id === OLD_ID ? row : undefined; },
    async active() { return undefined; },
    async pinnedVersions() { return [{ id: OLD_ID, sessions: 3 }]; },
    async seedActive() { throw new Error('not used'); },
  };
}

describe('harness version pinning', () => {
  it('a pinned session reads its own version, and a session without a pin reads the active one', async () => {
    const altered = alteredVersion();
    const pins = new HarnessPins(memoryVersionStore([altered]));
    const pinned = await withHarnessVersion(await pins.resolve(altered.id), async () => harnessText('persona.default'));
    const active = await withHarnessVersion(await pins.resolve(undefined), async () => harnessText('persona.default'));
    expect(pinned.endsWith(' [altered]')).toBe(true);
    expect(active.endsWith(' [altered]')).toBe(false);
    expect(active).toBe(harnessText('persona.default'));
  });

  it('a session pinned to a version missing a unit the code now needs keeps its own text for every other unit and gets the active text for the new one', async () => {
    const files: Record<string, string> = { ...harnessSeedVersion().files };
    delete files[ALTERED_ID];
    files['system.conflicts'] = (files['system.conflicts'] ?? '').replace(/\n$/, ' [old]\n');
    const resolved = await new HarnessPins(storeWith(files)).resolve(OLD_ID);
    expect(resolved.files[ALTERED_ID]).toBe(harnessSeedVersion().files[ALTERED_ID]);
    for (const [id, file] of Object.entries(files)) expect(resolved.files[id]).toBe(file);
    expect(resolved.files['system.conflicts']?.includes('[old]')).toBe(true);
  });

  it('a unit whose vars changed in code takes the active text for that unit only', async () => {
    const changed = changedVarsUnit();
    const files = oldRowFiles();
    const resolved = await new HarnessPins(storeWith(files)).resolve(OLD_ID);
    expect(resolved.files[changed.id]).toBe(harnessSeedVersion().files[changed.id]);
    for (const [id, file] of Object.entries(files)) {
      if (id === changed.id || id === DROPPED_ID) continue;
      expect(resolved.files[id]).toBe(file);
    }
  });

  it('a unit the code dropped is ignored', async () => {
    const resolved = await new HarnessPins(storeWith(oldRowFiles())).resolve(OLD_ID);
    expect(DROPPED_ID in resolved.files).toBe(false);
    expect(resolved.units.has(DROPPED_ID)).toBe(false);
  });

  it('the merged version of an old row compiles and has exactly the active unit set (the incident: a deploy added units)', async () => {
    const resolved = await new HarnessPins(storeWith(oldRowFiles())).resolve(OLD_ID);
    expect(Object.keys(resolved.files).sort()).toEqual(Object.keys(harnessSeedVersion().files).sort());
    for (const id of NEW_UNITS) expect(resolved.files[id]).toBe(harnessSeedVersion().files[id]);
    expect(withHarnessVersion(resolved, () => harnessText('persona.default'))).toBe(harnessText('persona.default'));
  });

  it('a session pinned before the delivery split gets the subagent tool texts, the two wake notes and the checkin rules, and loses the retired units', async () => {
    const seed = harnessSeedVersion();
    const unit = (id: string, placement: string, vars: string, body: string): string => `---\nid: ${id}\nplacement: ${placement}\nvars: ${vars}\n---\n${body}\n`;
    const files: Record<string, string> = { ...seed.files };
    for (const id of ['wake.automatic.nobody_waiting', 'wake.automatic.someone_waiting', 'tool.subagent_start', 'tool.subagent_message', 'tool.send_message.param.purpose', 'system.subagents']) delete files[id];
    const retired: Record<string, string> = {
      'wake.automatic': unit('wake.automatic', 'W', '[exit]', 'Your final reply is posted. {{exit}}'),
      'wake.quiet_exit': unit('wake.quiet_exit', 'W', '[]', 'finish_quietly is in your tools now'),
      'tool.finish_quietly': unit('tool.finish_quietly', 'T', '[]', 'End this run quietly.'),
      'tool.child_spawn': unit('tool.child_spawn', 'T', '[]', 'Spawn a child task.'),
      'tool.child_wait': unit('tool.child_wait', 'T', '[]', 'Wait for children.'),
      'system.helpers': unit('system.helpers', 'F', '[]', '## Helpers'),
    };
    files['checkin.rules'] = unit('checkin.rules', 'W', '[quiet]', 'Rules.{{quiet}}');
    Object.assign(files, retired);
    const resolved = await new HarnessPins(storeWith(files)).resolve(OLD_ID);
    for (const id of Object.keys(retired)) expect(resolved.units.has(id), id).toBe(false);
    for (const id of ['wake.automatic.nobody_waiting', 'wake.automatic.someone_waiting', 'tool.subagent_start', 'tool.subagent_message', 'system.subagents', 'checkin.rules']) expect(resolved.files[id], id).toBe(seed.files[id]);
  });

  it('a session pinned before the one-message reply gets the texting rules and the messages parameter text, and loses the paragraph-per-message talking rules', async () => {
    const seed = harnessSeedVersion();
    const files: Record<string, string> = { ...seed.files };
    delete files['system.voice'];
    files['system.speaking'] = `---\nid: system.speaking\nplacement: F\nvars: []\n---\n## Replying\n- Short plain sentences.\n`;
    delete files['tool.send_message.param.messages'];
    files['system.replying'] = `---\nid: system.replying\nplacement: F\nvars: []\n---\n## Replying\n- No offers at all.\n`;
    files['system.messaging'] = `---\nid: system.messaging\nplacement: F\nvars: []\n---\n## Talking\n- Emoji in at least every second reply.\n`;
    files['system.chatting'] = `---\nid: system.chatting\nplacement: F\nvars: []\n---\n## Talking\n- Reply in a chat.\n`;
    files['system.talking'] = `---\nid: system.talking\nplacement: F\nvars: []\n---\n## Talking\n- Each paragraph becomes its own message.\n`;
    const resolved = await new HarnessPins(storeWith(files)).resolve(OLD_ID);
    expect(resolved.units.has('system.talking')).toBe(false);
    expect(resolved.units.has('system.chatting')).toBe(false);
    expect(resolved.units.has('system.messaging')).toBe(false);
    expect(resolved.units.has('system.replying')).toBe(false);
    expect(resolved.units.has('system.speaking')).toBe(false);
    for (const id of ['system.voice','tool.send_message.param.messages']) expect(resolved.files[id], id).toBe(seed.files[id]);
  });

  it('a session pinned before the subagent rename loses the child unit ids and reads the active subagent texts', async () => {
    const seed = harnessSeedVersion();
    const renamed: [string, string][] = [
      ['wake.child_task', 'wake.subagent_task'],
      ['wake.child_update', 'wake.subagent_update'],
      ['child.research', 'subagent.research'],
      ['child.page_builder', 'subagent.page_builder'],
      ['tasks.child_binding_malformed', 'tasks.subagent_binding_malformed'],
      ['tasks.child_binding_unreadable', 'tasks.subagent_binding_unreadable'],
    ];
    const files: Record<string, string> = { ...seed.files };
    for (const [oldId, newId] of renamed) {
      const wanted = seed.units.get(newId);
      if (wanted === undefined) throw new Error(`the seed has no ${newId}`);
      delete files[newId];
      const placeholders = wanted.vars.map((name) => ` {{${name}}}`).join('');
      files[oldId] = `---\nid: ${oldId}\nplacement: ${wanted.placement}\nvars: [${wanted.vars.join(', ')}]\n---\nOLD TEXT${placeholders}\n`;
    }
    const resolved = await new HarnessPins(storeWith(files)).resolve(OLD_ID);
    for (const [oldId, newId] of renamed) {
      expect(resolved.units.has(oldId), oldId).toBe(false);
      expect(resolved.files[newId], newId).toBe(seed.files[newId]);
    }
    expect(withHarnessVersion(resolved, () => harnessText('wake.subagent_task'))).toBe(harnessText('wake.subagent_task'));
  });

  it('a pinned id missing from the store reads the active version', async () => {
    const logged: string[] = [];
    const pins = new HarnessPins(storeWith({}), (_fields, message) => logged.push(message));
    expect(await pins.resolve('hv_gone00000000')).toBe(harnessSeedVersion());
    expect(logged).toHaveLength(1);
  });

  it('the boot check logs, per pinned version, how many units are upgraded and dropped, and never fails', async () => {
    const lines: { fields: Record<string, unknown>; message: string }[] = [];
    await logPinnedUpgrades(storeWith(oldRowFiles()), harnessSeedVersion(), (fields, message) => lines.push({ fields, message }));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe('harness pins upgraded');
    expect(lines[0]?.fields).toMatchObject({ version: OLD_ID, sessions: 3, upgradedUnits: NEW_UNITS.length + 1, droppedUnits: 1 });
    const broken: HarnessVersionStore = { ...storeWith({}), async pinnedVersions() { throw new Error('db down'); } };
    await expect(logPinnedUpgrades(broken, harnessSeedVersion(), () => {})).resolves.toBeUndefined();
  });

  it('compaction re-pins the frozen system row to the active version and leaves its text alone', async () => {
    const store = createMemoryStore();
    const row = { id: 'tx_sys', sessionKey: 's', seq: 0, message: { ...systemMessage('rules', 'p', ['a'], 'ph', undefined, OLD_ID) }, compactionEpoch: 0, at: '2026-10-26T00:00:00.000Z' };
    await store.put('transcripts', row);
    const rewritten = await repinSystemRow(store, [row]);
    expect(rewritten?.message['content']).toBe('rules');
    expect(metaOf(rewritten?.message ?? {})).toMatchObject({ harnessVersion: harnessSeedVersion().id, toolOrder: ['a'], promptHash: 'ph' });
    expect(await repinSystemRow(store, rewritten === undefined ? [] : [rewritten])).toBeUndefined();
  });

  it('without a store every session reads the repository seed', async () => {
    const pins = new HarnessPins();
    expect(await pins.resolve('hv_000000000000')).toBe(harnessSeedVersion());
  });

  it('refuses a version that is missing a unit the code reads, and a unit whose placeholders do not match its vars', () => {
    const files: Record<string, string> = { ...harnessSeedVersion().files };
    delete files[ALTERED_ID];
    expect(() => compileHarnessVersion(files)).toThrow(HarnessError);
    expect(() => parseUnitFile('---\nid: checkin.rules\nplacement: W\nvars: [rules]\n---\nno placeholder here\n', 'checkin.rules')).toThrow(/placeholders do not match/);
  });
});
