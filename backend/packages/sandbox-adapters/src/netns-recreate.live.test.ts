/**
 * LIVE: a local container made before agents got network namespaces (no SYS_ADMIN) is removed and reported stale when the platform
 * first looks at it, so normal recovery recreates it on the same storage (BACKEND §7.9a). Uses a throwaway container it creates itself
 * and never touches another one. Skipped unless LIVE_DOCKER=1.
 *
 *   LIVE_DOCKER=1 LIVE_BASE_IMAGE=<desktop image> pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/netns-recreate.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import { createDockerDriver, runArguments } from './docker-driver.js';
import { LIVE_BASE_IMAGE } from './live-link.js';
import { ownerHash } from './local-container.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;

live('a container without SYS_ADMIN', () => {
  const owner = 'live-netns-recreate-' + randomUUID().slice(0, 8);
  const names: string[] = [];
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', env: { ...process.env, JUNO_LINK_TOKEN: 'x' } }).trim();

  /** The arguments the platform used before namespaces: the current ones without the SYS_ADMIN grant. */
  function oldContainer(): string {
    const name = `agent-local-${ownerHash(owner).slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    const spec = {
      image: LIVE_BASE_IMAGE,
      host: { template: LIVE_BASE_IMAGE, resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 1, vcpu: 1, idlePauseMinutes: 0 },
      env: { JUNO_LINK_URL: 'ws://host.docker.internal:1/x', JUNO_LINK_ID: 'link-live', JUNO_LINK_TOKEN: 'x' },
      link: { url: 'ws://host.docker.internal:1/x', id: 'link-live', token: 'x' },
    };
    const args = runArguments({ name, hash: ownerHash(owner), spec, storageArgs: [] });
    const at = args.indexOf('SYS_ADMIN');
    const withoutGrant = [...args.slice(0, at - 1), ...args.slice(at + 1)];
    names.push(name);
    return docker(...withoutGrant);
  }

  afterAll(() => {
    for (const name of names) {
      try {
        docker('rm', '-f', name);
      } catch {
        // already removed by the driver
      }
    }
  });

  it('is removed and reported as an outdated computer, so recovery recreates it',async () => {
    const id = oldContainer();
    expect(docker('inspect', '-f', '{{.HostConfig.CapAdd}}', id)).not.toContain('SYS_ADMIN');
    const driver = createDockerDriver({ ownerId: owner });
    const binding = { sandboxId: id } as E2bBinding;
    await expect(driver.assertCurrent!(binding, AbortSignal.timeout(60_000))).rejects.toMatchObject({ reason: 'image_outdated', computerId: id });
    expect(docker('ps', '-a', '-q', '--filter', `id=${id}`)).toBe('');
  }, 120_000);
});
