import { describe, expect, it } from 'vitest';
import { idleWindowMs } from './driver.js';
import type { E2bBinding } from '@agent-desktop/contracts';
import type { DockerCli } from './docker-cli.js';
import { createDockerDriver, runArguments } from './docker-driver.js';
import { MANAGED_LABEL, OWNER_LABEL, ownerHash } from './local-container.js';
import type { ComputerStorage } from './storage.js';

const spec = {
  image: 'juno-desktop:local',
  host: { template: 'juno-desktop:local', resolution: '1440x900', timeoutMs: 3_600_000, ramGb: 4, vcpu: 2, idlePauseMinutes: 30 },
  env: { JUNO_LINK_URL: 'ws://host.docker.internal:8795/v1/computer-link', JUNO_LINK_ID: 'link-id-0001', JUNO_LINK_TOKEN: 'secret-token-value' },
  link: { url: 'ws://host.docker.internal:8795/v1/computer-link', id: 'link-id-0001', token: 'secret-token-value' },
};

describe('local container arguments', () => {
  const args = runArguments({ name: 'agent-local-x', hash: 'h', spec, storageArgs: ['-v', 'vol:/juno'] });

  it('publishes no port at all: the computer is reached only through its own outbound link', () => {
    expect(args).not.toContain('-p');
    expect(args).not.toContain('-P');
    expect(args.join(' ')).not.toMatch(/--publish/);
    expect(args).toContain('host.docker.internal:host-gateway');
  });

  it('keeps the link token out of the argument list (its value travels in the CLI process environment)', () => {
    expect(args.join(' ')).not.toContain('secret-token-value');
    expect(args).toContain('JUNO_LINK_TOKEN');
    expect(args).toContain('JUNO_LINK_ID=link-id-0001');
  });

  it('keeps the storage arguments before the image', () => {
    expect(args.indexOf('vol:/juno')).toBeLessThan(args.indexOf('juno-desktop:local'));
    expect(args.at(-1)).toBe('juno-desktop:local');
  });
});

describe('idle window', () => {
  it('is at least a minute and at most the lifetime; non-positive means the lifetime', () => {
    expect(idleWindowMs(0.1, 3_600_000)).toBe(60_000);
    expect(idleWindowMs(500, 3_600_000)).toBe(3_600_000);
    expect(idleWindowMs(30, 3_600_000)).toBe(30 * 60_000);
    expect(idleWindowMs(0, 3_600_000)).toBe(3_600_000);
    expect(idleWindowMs(undefined, 3_600_000)).toBe(30 * 60_000);
  });
});

describe('image upgrade at a cold boundary', () => {
  const OLD = 'sha256:old';
  const NEW = 'sha256:new';
  const inspect = (status: string) =>
    JSON.stringify([{ Image: OLD, State: { Status: status }, Config: { Image: 'juno-desktop:local', Labels: { [OWNER_LABEL]: ownerHash('o1'), [MANAGED_LABEL]: '1' } } }]);

  function fakeDocker(status: string, tag: { exitCode: number; stdout: string }) {
    const calls: string[][] = [];
    const docker: DockerCli = {
      async run(args) {
        calls.push(args);
        if (args[0] === 'inspect') return { exitCode: 0, stdout: inspect(status), stderr: '' };
        if (args[0] === 'image') return { ...tag, stderr: '' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    return { calls, driver: createDockerDriver({ ownerId: 'o1', docker }) };
  }
  const binding = { sandboxId: 'c1' } as E2bBinding;
  const signal = new AbortController().signal;
  const ops = (calls: string[][]) => calls.map((c) => c[0]);

  it('unpauses a container whose image is current', async () => {
    const { calls, driver } = fakeDocker('paused', { exitCode: 0, stdout: `${OLD}\n` });
    await driver.resume!(binding, signal);
    expect(ops(calls)).toContain('unpause');
    expect(ops(calls)).not.toContain('rm');
  });

  it('removes an outdated container at resume and reports it stale, so recovery creates a new one on the same storage', async () => {
    const { calls, driver } = fakeDocker('paused', { exitCode: 0, stdout: `${NEW}\n` });
    await expect(driver.resume!(binding, signal)).rejects.toMatchObject({ reason: 'image_outdated', computerId: 'c1' });
    expect(calls).toContainEqual(['rm', '-f', 'c1']);
    expect(ops(calls)).not.toContain('unpause');
  });

  it('keeps the container when the image tag cannot be inspected', async () => {
    const { calls, driver } = fakeDocker('exited', { exitCode: 1, stdout: '' });
    await driver.start(binding, signal);
    expect(ops(calls)).toContain('start');
    expect(ops(calls)).not.toContain('rm');
  });
});

describe('account deletion: every computer of the owner', () => {
  const signal = new AbortController().signal;
  const labelled = (owner: string, managed = '1') => ({ [OWNER_LABEL]: ownerHash(owner), [MANAGED_LABEL]: managed });
  const inspectOf = (labels: Record<string, string>) => JSON.stringify([{ Image: 'sha256:img', State: { Status: 'running' }, Config: { Image: 'juno-desktop:local', Labels: labels } }]);

  /** `ps` lists what the label filter matched; each `inspect` answers with the container's real labels, so a wrong match is still refused. */
  function fakeDocker(listed: string[], containers: Record<string, Record<string, string>>) {
    const calls: string[][] = [];
    const docker: DockerCli = {
      async run(args) {
        calls.push(args);
        if (args[0] === 'ps') return { exitCode: 0, stdout: listed.join('\n') + '\n', stderr: '' };
        if (args[0] === 'inspect') {
          const labels = containers[args[1] ?? ''];
          return labels === undefined ? { exitCode: 1, stdout: '', stderr: `Error: No such object: ${args[1]}` } : { exitCode: 0, stdout: inspectOf(labels), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    return { calls, docker };
  }
  const storage: ComputerStorage = { kind: 'local-volume', dockerArgs: async () => [], attach: async () => undefined, removeVolumes: async () => ['juno-vol-x-home'] };

  it('filters by the owner\'s labels, removes each one it can verify as theirs, and then the volumes', async () => {
    const { calls, docker } = fakeDocker(['c1', 'c2'], { c1: labelled('o1'), c2: labelled('o1') });
    const driver = createDockerDriver({ ownerId: 'o1', docker, storage });
    expect(await driver.destroyOwned?.(signal)).toEqual({ computers: 2, volumes: ['juno-vol-x-home'] });
    expect(calls[0]).toEqual(['ps', '-aq', '--no-trunc', '--filter', `label=${OWNER_LABEL}=${ownerHash('o1')}`, '--filter', `label=${MANAGED_LABEL}=1`]);
    expect(calls.filter((call) => call[0] === 'rm')).toEqual([['rm', '-f', 'c1'], ['rm', '-f', 'c2']]);
  });

  it('never removes a container whose labels are not the owner\'s, and skips one that vanished meanwhile', async () => {
    const { calls, docker } = fakeDocker(['foreign', 'unmanaged', 'gone', 'mine'], { foreign: labelled('o2'), unmanaged: labelled('o1', '0'), mine: labelled('o1') });
    const driver = createDockerDriver({ ownerId: 'o1', docker });
    // The ownership guard throws for a container that is listed but is not this owner's; nothing after it is removed either.
    await expect(driver.destroyOwned?.(signal)).rejects.toMatchObject({ code: 'not_allowed' });
    expect(calls.some((call) => call[0] === 'rm')).toBe(false);
    const rest = fakeDocker(['gone', 'mine'], { mine: labelled('o1') });
    expect(await createDockerDriver({ ownerId: 'o1', docker: rest.docker }).destroyOwned?.(signal)).toEqual({ computers: 1, volumes: [] });
    expect(rest.calls.filter((call) => call[0] === 'rm')).toEqual([['rm', '-f', 'mine']]);
  });
});
