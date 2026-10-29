/**
 * LIVE regression (fix 85fcc36): every agent is its own Linux user, and the browser helper kept its ref/watch state in one
 * shared /tmp/agent-browser made (0700) by whichever agent used its browser first, so the next agent's snapshot failed with
 * "Permission denied" on <port>.watch.log. Two agents now take turns with the browser, each on its own screen.
 *
 *   BUN=/path/to/bun LIVE_DOCKER=1 pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/browser-agents.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import { agentUser } from './isolation.js';
import { liveImage, startLiveLink, type LiveLink } from './live-link.js';
import { createLocalProvider } from './local.js';
import type { ScreenRequest } from './types.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;
const A = 'agent-turns-a';
const B = 'agent-turns-b';
const signal = () => AbortSignal.timeout(240_000);
const screen = (agentId: string, displayNo: number): ScreenRequest => ({ agentId, displayNo, resolution: '1024x768', controlPassword: 'ctl-' + displayNo, viewPassword: 'view-' + displayNo });

live('two agents take turns with the browser', () => {
  let link: LiveLink;
  let provider: ReturnType<typeof createLocalProvider>;
  let binding: E2bBinding;

  const snapshot = async (agentId: string, displayNo: number) => {
    const result = await provider.act(binding, agentId, displayNo, { kind: 'browser', input: { action: 'snapshot' } }, signal());
    if (result.browser?.action !== 'snapshot') throw new Error('no snapshot result');
    return result.browser;
  };
  const sh = async (agentId: string, displayNo: number, command: string) => {
    const result = await provider.act(binding, agentId, displayNo, { kind: 'shell', input: { command, timeoutMs: 60_000 } }, signal());
    if (!result.shell) throw new Error('no shell result');
    return result.shell;
  };

  beforeAll(async () => {
    link = await startLiveLink();
    provider = createLocalProvider({ ownerId: 'live-browser-turns', image: liveImage(), hub: link.hub, linkUrl: link.linkUrl });
    binding = await provider.create({ template: liveImage(), resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 }, signal());
    await provider.ensureScreen(binding, screen(A, 1), signal());
    await provider.ensureScreen(binding, screen(B, 2), signal());
  }, 600_000);

  afterAll(() => {
    try {
      if (binding) execFileSync('docker', ['rm', '-f', binding.sandboxId], { stdio: 'ignore' });
    } finally {
      provider?.dispose();
      link?.close();
    }
  }, 60_000);

  it('A, then B, then A again: every snapshot succeeds, and the helper state is private to each agent', async () => {
    expect((await snapshot(A, 1)).url).toBeTruthy();
    expect((await snapshot(B, 2)).url).toBeTruthy();
    expect((await snapshot(A, 1)).url).toBeTruthy();
    expect((await snapshot(B, 2)).url).toBeTruthy();
    // Each agent's helper state sits in its own home...
    expect((await sh(A, 1, 'ls -A "$HOME/.agent-browser"')).stdout).toContain('watch.log');
    expect((await sh(B, 2, 'ls -A "$HOME/.agent-browser"')).stdout).toContain('watch.log');
    // ...and B cannot read A's.
    const peek = await sh(B, 2, `ls /home/${agentUser(A)}/.agent-browser 2>&1; echo exit=$?`);
    expect(peek.stdout).toContain('Permission denied');
    expect(peek.stdout).not.toContain('watch.log');
  }, 600_000);
});
