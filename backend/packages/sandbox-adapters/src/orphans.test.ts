import { describe, expect, it } from 'vitest';
import type { DockerCli } from './docker-cli.js';
import { DEPLOYMENT_LABEL, LIFETIME_LABEL, LINK_LABEL } from './docker-driver.js';
import { MANAGED_LABEL, OWNER_LABEL } from './local-container.js';
import { ORPHAN_GRACE_MS, deploymentId, reapDecision, sweepManagedContainers } from './orphans.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const base = { [MANAGED_LABEL]: '1', [DEPLOYMENT_LABEL]: 'dep-a', [LINK_LABEL]: 'link-1', [LIFETIME_LABEL]: String(HOUR), [OWNER_LABEL]: 'a'.repeat(64) };
const decide = (labels: Record<string, string>, created: string, bound: string[] = [], deployment = 'dep-a') =>
  reapDecision({ labels, created, now: NOW, deployment, boundLinkIds: new Set(bound) });

describe('reapDecision', () => {
  it('removes only a container of this deployment that is past lifetime plus the grace', () => {
    expect(decide(base, ago(HOUR + ORPHAN_GRACE_MS + 1000))).toBe('remove');
    expect(decide(base, ago(HOUR + ORPHAN_GRACE_MS - 1000))).toBe('keep');
    expect(decide(base, ago(5 * 60_000))).toBe('keep');
  });

  it('adopts a current computer however old it is, and never removes it', () => {
    expect(decide(base, ago(30 * 24 * HOUR), ['link-1'])).toBe('adopt');
  });

  it('never touches a container without the managed label, or another deployment\'s, or one made before the deployment label existed', () => {
    const old = ago(30 * 24 * HOUR);
    expect(decide({ ...base, [MANAGED_LABEL]: '0' }, old)).toBe('keep');
    expect(decide({}, old)).toBe('keep');
    expect(decide({ ...base, [DEPLOYMENT_LABEL]: 'dep-b' }, old)).toBe('keep');
    const { [DEPLOYMENT_LABEL]: _unused, ...unlabelled } = base;
    expect(decide(unlabelled, old)).toBe('keep');
    expect(decide(base, old, [], '')).toBe('keep');
  });

  it('keeps what it cannot date, and uses the default lifetime when the label is unreadable', () => {
    expect(decide(base, 'not-a-date')).toBe('keep');
    expect(decide({ ...base, [LIFETIME_LABEL]: 'x' }, ago(HOUR + ORPHAN_GRACE_MS + 1000))).toBe('remove');
  });
});

describe('deploymentId', () => {
  it('prefers the explicit id, derives a stable one from the secret otherwise, and never contains the secret', () => {
    expect(deploymentId('e2e-1', 'secret')).toBe('e2e-1');
    expect(deploymentId('', 'secret')).toBe(deploymentId('', 'secret'));
    expect(deploymentId('', 'secret')).not.toBe(deploymentId('', 'other'));
    expect(deploymentId('', 'secret')).not.toContain('secret');
    expect(deploymentId('', '')).toBe('');
  });
});

describe('sweepManagedContainers', () => {
  const inspectOf = (id: string, labels: Record<string, string>, created: string, status = 'running') =>
    JSON.stringify([{ Id: id, Created: created, Image: 'sha256:x', State: { Status: status }, Config: { Image: 'juno-desktop:local', Labels: labels } }]);

  function fakeDocker(containers: Record<string, { labels: Record<string, string>; created: string; status?: string }>, volumes: Record<string, string[]>) {
    const calls: string[][] = [];
    const docker: DockerCli = {
      async run(args) {
        calls.push(args);
        if (args[0] === 'ps') return { exitCode: 0, stdout: Object.keys(containers).join('\n'), stderr: '' };
        if (args[0] === 'inspect') {
          const entry = containers[args[1] ?? ''];
          return entry ? { exitCode: 0, stdout: inspectOf(args[1] ?? '', entry.labels, entry.created, entry.status), stderr: '' } : { exitCode: 1, stdout: '', stderr: 'Error: No such object' };
        }
        if (args[0] === 'rm') {
          delete containers[args[2] ?? ''];
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (args[0] === 'volume' && args[1] === 'ls') {
          const owner = (args.find((arg) => arg.startsWith(`label=${OWNER_LABEL}=`)) ?? '').split('=').pop() ?? '';
          return { exitCode: 0, stdout: (volumes[owner] ?? []).join('\n'), stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };
    return { docker, calls };
  }

  const stale = ago(HOUR + ORPHAN_GRACE_MS + HOUR);
  const run = (docker: DockerCli, accountHashes: Set<string> | null, bound: string[] = []) =>
    sweepManagedContainers({ cli: docker, deployment: 'dep-a', boundLinkIds: new Set(bound), accountHashes, now: NOW, signal: new AbortController().signal });

  it('removes the abandoned container and, for an owner that is no account here, its volumes', async () => {
    const stranger = 'b'.repeat(64);
    const { docker, calls } = fakeDocker(
      { c1: { labels: { ...base, [OWNER_LABEL]: stranger }, created: stale }, c2: { labels: { ...base, [LINK_LABEL]: 'link-2', [OWNER_LABEL]: stranger }, created: ago(60_000) } },
      { [stranger]: ['juno-vol-x-home', 'juno-vol-x-workspace'] },
    );
    const report = await run(docker, new Set(['c'.repeat(64)]));
    expect(report.removed).toEqual(['c1']);
    // The young sibling of the same owner is still there, so the owner's volumes stay.
    expect(report.volumes).toEqual([]);
    expect(calls.filter((call) => call[0] === 'volume' && call[1] === 'rm')).toEqual([]);
  });

  it('removes the volumes once nothing of that owner is left, and never when the owner is an account or the account list is unknown', async () => {
    const stranger = 'b'.repeat(64);
    const make = () => fakeDocker({ c1: { labels: { ...base, [OWNER_LABEL]: stranger }, created: stale } }, { [stranger]: ['juno-vol-x-home'] });
    const gone = make();
    expect((await run(gone.docker, new Set())).volumes).toEqual(['juno-vol-x-home']);
    const account = make();
    expect((await run(account.docker, new Set([stranger]))).volumes).toEqual([]);
    expect(account.calls.some((call) => call[0] === 'rm')).toBe(true); // the container still goes
    const unknown = make();
    expect((await run(unknown.docker, null)).volumes).toEqual([]);
  });

  it('adopts a running current computer and leaves a foreign one alone', async () => {
    const { docker, calls } = fakeDocker(
      {
        mine: { labels: base, created: stale },
        foreign: { labels: { ...base, [DEPLOYMENT_LABEL]: 'dep-b', [LINK_LABEL]: 'link-9' }, created: stale },
        unmanaged: { labels: { [DEPLOYMENT_LABEL]: 'dep-a' }, created: stale },
      },
      {},
    );
    const report = await run(docker, new Set(), ['link-1']);
    expect(report.adopt.map((info) => info.id)).toEqual(['mine']);
    expect(report.removed).toEqual([]);
    expect(calls.some((call) => call[0] === 'rm')).toBe(false);
  });
});
