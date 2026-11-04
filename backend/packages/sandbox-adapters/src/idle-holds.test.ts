import { afterEach, describe, expect, it, vi } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import type { LifecycleDriver, MachineState } from './driver.js';
import type { LinkConnection, LinkHub } from './link-hub.js';
import { createLinkedProvider } from './linked-provider.js';

const signal = () => new AbortController().signal;
const WINDOW = 60_000;

/** A linked provider over a fake driver and link with a 1-minute idle window; `suspended` lists the suspends, `state` the machine. */
async function setup(initial: MachineState = 'running') {
  let state: MachineState = initial;
  const suspended: string[] = [];
  const resumed: string[] = [];
  const link = {
    id: 'link-1', bootId: 'boot-1', open: true,
    exec: async () => ({ stdout: 'IDLE\n', stderr: '', exitCode: 0 }),
    writeFile: async () => undefined,
    health: async () => ({}),
  } as unknown as LinkConnection;
  const hub = { tokenFor: () => 't', waitFor: async () => link, get: () => link, drop: () => undefined } as unknown as LinkHub;
  const driver: LifecycleDriver = {
    kind: 'fake',
    create: async () => ({ sandboxId: 'sbx-1', template: 'test' }),
    status: async () => state,
    start: async () => { state = 'running'; },
    stop: async () => { state = 'stopped'; },
    destroy: async () => undefined,
    suspend: async (binding: E2bBinding) => { suspended.push(binding.sandboxId); state = 'suspended'; },
    resume: async (binding: E2bBinding) => { resumed.push(binding.sandboxId); state = 'running'; },
  };
  const provider = createLinkedProvider({ driver, hub, linkUrl: 'ws://x', ownerId: 'owner', image: 'img' });
  const binding = await provider.create({ template: 'img', resolution: '1280x800', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 1 }, signal());
  return { provider, binding, suspended, resumed, state: () => state, setState: (next: MachineState) => { state = next; } };
}

describe('holds keep a computer from pausing (BACKEND 7.3b)', () => {
  afterEach(() => vi.useRealTimers());

  it('pauses one window after the last use when nothing is held', async () => {
    vi.useFakeTimers();
    const { provider, suspended } = await setup();
    await vi.advanceTimersByTimeAsync(WINDOW - 1_000);
    expect(suspended).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(suspended).toEqual(['sbx-1']);
    provider.dispose();
  });

  it('does not pause while held, however long, and pauses one window after the release', async () => {
    vi.useFakeTimers();
    const { provider, suspended } = await setup();
    provider.hold('run-a', 120_000);
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(WINDOW);
      provider.hold('run-a', 120_000); // the run's renewal
    }
    expect(suspended).toEqual([]);

    // Half a window after the last check: the countdown restarts at the release, it does not finish the old window.
    await vi.advanceTimersByTimeAsync(WINDOW / 2);
    provider.release('run-a');
    await vi.advanceTimersByTimeAsync(WINDOW - 1_000);
    expect(suspended).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(suspended).toEqual(['sbx-1']);
    provider.dispose();
  });

  it('with two holds pauses only after both are released', async () => {
    vi.useFakeTimers();
    const { provider, suspended } = await setup();
    provider.hold('run-a', 600_000);
    provider.hold('run-b', 600_000);
    await vi.advanceTimersByTimeAsync(3 * WINDOW);

    provider.release('run-a');
    await vi.advanceTimersByTimeAsync(3 * WINDOW);
    expect(suspended).toEqual([]);

    provider.release('run-b');
    await vi.advanceTimersByTimeAsync(WINDOW + 1_000);
    expect(suspended).toEqual(['sbx-1']);
    provider.dispose();
  });

  it('a hold nobody renews or releases lapses, and the computer then pauses', async () => {
    vi.useFakeTimers();
    const { provider, suspended } = await setup();
    provider.hold('lost-run', 90_000);
    await vi.advanceTimersByTimeAsync(2 * WINDOW);
    expect(suspended).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * WINDOW);
    expect(suspended).toEqual(['sbx-1']);
    provider.dispose();
  });

  it('cuts a very long ask to the cap', async () => {
    vi.useFakeTimers();
    const { provider, suspended } = await setup();
    provider.hold('forever', Number.MAX_SAFE_INTEGER);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(suspended).toEqual([]);
    await vi.advanceTimersByTimeAsync(4 * WINDOW);
    expect(suspended).toEqual(['sbx-1']);
    provider.dispose();
  });

  it('never resumes a suspended computer, and holds it once something else does', async () => {
    vi.useFakeTimers();
    const { provider, binding, resumed, suspended, state } = await setup('suspended');
    provider.hold('run-a', 600_000);
    await vi.advanceTimersByTimeAsync(3 * WINDOW);
    expect(resumed).toEqual([]);
    expect(state()).toBe('suspended');

    // The first real call wakes it as always; the hold already in place keeps it up past the idle window.
    await provider.connect(binding, signal());
    expect(resumed).toEqual(['sbx-1']);
    await vi.advanceTimersByTimeAsync(3 * WINDOW);
    expect(suspended).toEqual([]);
    expect(state()).toBe('running');
    provider.dispose();
  });
});
