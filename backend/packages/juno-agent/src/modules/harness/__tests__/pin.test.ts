/**
 * Harness versions (BACKEND §11.2): a session reads the version it is pinned to, a new session reads the active one, and a version that
 * does not match the code's ids or placeholders is refused.
 */
import { describe, expect, it } from 'vitest';
import { compileHarnessVersion, harnessSeedVersion, harnessText, HarnessError, parseUnitFile, withHarnessVersion } from '../loader.js';
import { HarnessPins, type HarnessVersionRow, type HarnessVersionStore } from '../store.js';

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
