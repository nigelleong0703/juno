import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFakeProvider } from './fake.js';
import { createSandboxHome } from './home.js';

const binding = { sandboxId: 'fake-1', template: 'fake' };
const signal = new AbortController().signal;

describe('sandbox home (real shell on the fake computer)', () => {
  const withHome = async <T>(fn: (home: ReturnType<typeof createSandboxHome>) => Promise<T>): Promise<T> =>
    createFakeProvider().withRuntime(binding, signal, (runtime) => fn(createSandboxHome(runtime)));

  it('writes, reads, guards with expectedHash and deletes', async () => {
    await withHome(async (home) => {
      expect(await home.read('USER.md')).toBeNull();
      const { hash } = await home.write('agents/a1/SOUL.md', 'be brief');
      expect(await home.read('agents/a1/SOUL.md')).toEqual({ content: 'be brief', hash });
      await expect(home.write('agents/a1/SOUL.md', 'x', 'stale')).rejects.toMatchObject({ code: 'home_conflict' });
      await home.write('agents/a1/SOUL.md', 'be brief and kind', hash);
      await expect(home.delete('agents/a1/SOUL.md', hash)).rejects.toMatchObject({ code: 'home_conflict' });
      await home.delete('agents/a1/SOUL.md');
      expect(await home.read('agents/a1/SOUL.md')).toBeNull();
    });
  });

  it('puts uploaded bytes in the home unchanged, skips a copy that is already there, and refuses paths outside it', async () => {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255, 254, 10, 13]);
    const provider = createFakeProvider();
    await provider.withRuntime(binding, signal, async (runtime) => {
      const home = createSandboxHome(runtime);
      const first = await home.put('uploads/lib-1/My Resume.pdf', bytes);
      expect(first).toMatchObject({ written: true, hash: createHash('sha256').update(bytes).digest('hex') });
      expect(Buffer.from(await runtime.readBytes((runtime.homeRoot ?? '') + '/uploads/lib-1/My Resume.pdf'))).toEqual(bytes);
      expect(await home.put('uploads/lib-1/My Resume.pdf', bytes)).toEqual({ ...first, written: false });
      expect(await home.put('uploads/lib-1/My Resume.pdf', Buffer.from('other'))).toMatchObject({ written: true });
      await expect(home.put('../evil.pdf', bytes)).rejects.toMatchObject({ code: 'not_allowed' });
    });
  });

  it('extracts nothing from a file that is not there, and reports a tool that cannot run', async () => {
    await withHome(async (home) => {
      await expect(home.extractText('uploads/lib-1/none.pdf', 'pdf')).rejects.toMatchObject({ code: 'failed' });
      await home.put('uploads/lib-1/a.pdf', Buffer.from('%PDF-1.4'));
      // The test computer has no platform skills; the real extraction is covered by skills.live.test.ts.
      await expect(home.extractText('uploads/lib-1/a.pdf', 'pdf')).rejects.toMatchObject({ code: 'failed' });
    });
  });

  it('creates an agent\'s daily log once and leaves what is in it', async () => {
    await withHome(async (home) => {
      const log = 'memory/2026-10-14/a1.md';
      await home.ensure(log);
      expect(await home.read(log)).toMatchObject({ content: '' });
      await home.write(log, '- 09:00 note\n');
      await home.ensure(log);
      expect(await home.read(log)).toMatchObject({ content: '- 09:00 note\n' });
      await expect(home.ensure('USER.md')).rejects.toMatchObject({ code: 'not_allowed' });
    });
    const provider = createFakeProvider();
    await provider.withRuntime(binding, signal, async (runtime) => {
      await createSandboxHome(runtime).ensure('memory/2026-10-14/a1.md');
      const mode = await runtime.run('stat -c %a "$HOME/juno/memory/2026-10-14/a1.md" 2>/dev/null || stat -f %Lp "$HOME/juno/memory/2026-10-14/a1.md"');
      // The test double has no agent users; the real owner (juno-<id>, 0640) is checked by the live docker test.
      expect(mode.stdout.trim()).toBe('644');
    });
  });

  it('refuses paths outside /juno, including through a symlink', async () => {
    await withHome(async (home) => {
      await expect(home.write('../evil.md', 'x')).rejects.toMatchObject({ code: 'not_allowed' });
      await expect(home.write('/etc/x', 'x')).rejects.toMatchObject({ code: 'not_allowed' });
    });
    const provider = createFakeProvider();
    await provider.withRuntime(binding, signal, async (runtime) => {
      const home = createSandboxHome(runtime);
      await runtime.run('mkdir -p "$HOME/juno" "$HOME/outside" && ln -s "$HOME/outside" "$HOME/juno/link"');
      await expect(home.write('link/x.md', 'x')).rejects.toMatchObject({ code: 'not_allowed' });
    });
  });

  it('snapshots hashes of the files the sync watches, with the marker flag', async () => {
    await withHome(async (home) => {
      expect((await home.snapshot('a1')).synced).toBe(false);
      await home.write('USER.md', 'me');
      await home.write('agents/a1/SOUL.md', 'soul');
      await home.write('agents/other/SOUL.md', 'not mine');
      await home.write('memory/2026-10-14/a1.md', '- note');
      await home.write('.juno-sync', 'now');
      const snapshot = await home.snapshot('a1');
      expect(snapshot.synced).toBe(true);
      expect(snapshot.files.map((file) => file.path).sort()).toEqual(['USER.md', 'agents/a1/SOUL.md', 'memory/2026-10-14/a1.md']);
      expect(snapshot.files.every((file) => /^[0-9a-f]{64}$/.test(file.hash))).toBe(true);
    });
  });
});
