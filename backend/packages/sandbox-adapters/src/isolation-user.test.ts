import { describe, expect, it } from 'vitest';
import { agentCommand, agentUser, homeAgentOf, homeOwnership } from './isolation-user.js';
import { netScript, ownAgentCdpRules, validatePackages } from './isolation.js';
import { screenPorts } from './ports.js';

describe('per-agent isolation rules (BACKEND 7.9)', () => {
  const A = 'agent-a';
  const B = 'agent-b';

  it('lets the agent\'s own user reach its own CDP port, placed ahead of the root-only reject, and only that uid', () => {
    const script = netScript(1, A);
    const own = screenPorts(1).cdp;
    expect(script).toContain(ownAgentCdpRules(own, agentUser(A))[2]);
    expect(script).toContain(`id -u ${agentUser(A)}`);
    expect(script).not.toContain(`id -u ${agentUser(B)}`);
    // The accept goes to the top of JUNO_ISO, so the root-only reject of the same port (also in this script) cannot win.
    expect(ownAgentCdpRules(own, agentUser(A))[2]).toContain('-I JUNO_ISO 1');
  });

  it('removes an accept an earlier boot gave another agent on the same port before it adds its own', () => {
    const [remove] = ownAgentCdpRules(9223, agentUser(A));
    expect(remove).toContain('--dport 9223 ');
    expect(remove).toContain('-j ACCEPT');
    expect(remove).toContain('-D JUNO_ISO');
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
    expect(wrapped.indexOf('exit 97')).toBeLessThan(wrapped.indexOf('exec setpriv'));
  });

  it('accepts only apt package names', () => {
    expect(validatePackages(['ffmpeg', 'libstdc++6', 'python3.11'])).toHaveLength(3);
    for (const bad of ['', 'a', '-y', 'Foo', 'a b', 'a;rm', '$(x)', 'x/y']) expect(() => validatePackages([bad])).toThrow();
    expect(() => validatePackages([])).toThrow();
  });
});
