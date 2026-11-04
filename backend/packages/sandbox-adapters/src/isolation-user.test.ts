import { describe, expect, it } from 'vitest';
import { egressRuleset, nameserversOf } from './egress.js';
import { agentCommand, agentNetnsPath, agentUser, homeAgentOf, homeOwnership, inAgentNetns } from './isolation-user.js';
import { validatePackages } from './isolation.js';
import { agentNetnsScript, hostNetScript } from './netns.js';

describe('per-agent isolation rules (BACKEND 7.9)', () => {
  const A = 'agent-a';
  const B = 'agent-b';

  it('gives every agent its own namespace, named like its user', () => {
    expect(agentNetnsPath(A)).toBe(`/run/netns/${agentUser(A)}`);
    expect(agentNetnsPath(A)).not.toBe(agentNetnsPath(B));
    expect(inAgentNetns(A)).toBe(`nsenter --net=${agentNetnsPath(A)}`);
    const script = agentNetnsScript(A);
    expect(script).toContain(`NS=${agentUser(A)}`);
    expect(script).not.toContain(agentUser(B));
  });

  it('refuses to run a command when the agent\'s namespace is gone (a cold start loses it), and runs it inside it otherwise', () => {
    const wrapped = agentCommand(A, 'true');
    expect(wrapped.indexOf(`${inAgentNetns(A)} true`)).toBeGreaterThan(-1);
    expect(wrapped.indexOf(`${inAgentNetns(A)} true`)).toBeLessThan(wrapped.indexOf('exit 97'));
    expect(wrapped).toContain(`exec ${inAgentNetns(A)} setpriv`);
  });

  it('blocks private addresses on the agents\' forward path but lets DNS through to the configured nameservers first', () => {
    const rules = egressRuleset(['192.168.65.7']);
    expect(rules).toContain('ip daddr { 192.168.65.7 } udp dport 53 accept');
    expect(rules.indexOf('udp dport 53 accept')).toBeLessThan(rules.indexOf('reject with icmp type admin-prohibited'));
    for (const range of ['10.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16']) expect(rules).toContain(range);
    // Nothing an agent sends reaches a service of the root namespace (the sandbox daemon, the link, VNC, the gateway).
    expect(rules).toMatch(/chain input \{[^}]*iifname "jh-\*" drop/);
    expect(hostNetScript([])).toContain('ip_forward=1');
  });

  it('reads IPv4 nameservers from resolv.conf and ignores the rest', () => {
    expect(nameserversOf('# c\nnameserver 8.8.8.8\nnameserver 2001:4860::8888\nsearch x\nnameserver 192.168.65.7\nnameserver 8.8.8.8\n')).toEqual(['8.8.8.8', '192.168.65.7']);
  });

  it('names users from the agent id: stable, short enough for Linux, distinct', () => {
    expect(agentUser(A)).toBe(agentUser(A));
    expect(agentUser(A)).not.toBe(agentUser(B));
    expect(agentUser(A)).toMatch(/^juno-[0-9a-f]{12}$/);
    expect(agentUser('x'.repeat(128)).length).toBeLessThanOrEqual(32);
  });

  it('gives every path under /juno the owner and mode of the table', () => {
    const shared = { owner: 'root', group: 'juno' };
    expect(homeOwnership('', true)).toEqual({ ...shared, mode: '0750' });
    expect(homeOwnership('MEMORY.md', false)).toEqual({ ...shared, mode: '0640' });
    expect(homeOwnership('memory/bank/people.md', false)).toEqual({ ...shared, mode: '0640' });
    expect(homeOwnership('memory/2026-10-14', true)).toEqual({ ...shared, mode: '0750' });
    // Only the agent itself writes its daily log; everyone reads it.
    expect(homeOwnership(`memory/2026-10-14/${A}.md`, false)).toEqual({ owner: agentUser(A), group: 'juno', mode: '0640' });
    // An agent's identity files are private to it.
    expect(homeOwnership(`agents/${A}`, true)).toEqual({ owner: 'root', group: agentUser(A), mode: '0750' });
    expect(homeOwnership(`agents/${A}/SOUL.md`, false)).toEqual({ owner: 'root', group: agentUser(A), mode: '0640' });
    expect(homeOwnership('agents', true)).toEqual({ owner: 'root', group: 'root', mode: '0711' });
    expect(homeOwnership('dreams/2026-10-14.md', false)).toEqual({ owner: 'root', group: 'root', mode: '0600' });
    expect(homeOwnership('self_improvement', true)).toEqual({ owner: 'root', group: 'root', mode: '0700' });
    // Uploaded files: every agent reads them, only the platform wrote them.
    expect(homeOwnership('uploads/lib-1', true)).toEqual({ ...shared, mode: '0750' });
    expect(homeOwnership('uploads/lib-1/resume.pdf', false)).toEqual({ ...shared, mode: '0640' });
    expect(homeAgentOf(`agents/${A}/skills/x.md`)).toBe(A);
    expect(homeAgentOf(`memory/2026-10-14/${B}.md`)).toBe(B);
    expect(homeAgentOf('MEMORY.md')).toBeUndefined();
  });

  it('runs a command as the agent user and refuses to run it when the computer is not isolated', () => {
    const wrapped = agentCommand(A, "echo 'hi'");
    expect(wrapped).toContain(`--reuid=${agentUser(A)}`);
    expect(wrapped).toContain('/etc/juno/isolation-v1');
    expect(wrapped.indexOf('exit 97')).toBeLessThan(wrapped.indexOf('exec nsenter'));
  });

  it('accepts only apt package names', () => {
    expect(validatePackages(['ffmpeg', 'libstdc++6', 'python3.11'])).toHaveLength(3);
    for (const bad of ['', 'a', '-y', 'Foo', 'a b', 'a;rm', '$(x)', 'x/y']) expect(() => validatePackages([bad])).toThrow();
    expect(() => validatePackages([])).toThrow();
  });
});
