import { describe, expect, it } from 'vitest';
import { agentNameInHeading, agentSectionHeading, agentSectionId, replyStyleFor, splitRuleTags } from '../reply-style.js';

const FILE = [
  '- Keep it short. [claim:clm_a]',
  '## Style',
  '- Plain.',
  agentSectionHeading('Juno', 'agt-1'),
  '- Only Juno. [src:itm-1]',
  agentSectionHeading('Sol', 'agt-2'),
  '- Only Sol.',
  '## Agent: "Mint"',
  '- Only Mint, id unknown.',
  '## To confirm',
  '- Ask once about the trip.',
].join('\n');

describe('reply style format', () => {
  it('gives an agent the shared sections plus its own canonical one, and nobody the section that names an agent without an id', () => {
    const juno = replyStyleFor(FILE, 'agt-1');
    expect(juno).toContain('Keep it short.');
    expect(juno).toContain('Plain.');
    expect(juno).toContain('Only Juno.');
    expect(juno).toContain('Ask once about the trip.');
    expect(juno).not.toContain('Only Sol.');
    expect(juno).not.toContain('Only Mint');
    expect(replyStyleFor(FILE, 'agt-2')).not.toContain('Only Juno.');
    expect(replyStyleFor(FILE, 'agt-3')).not.toContain('Only Mint');
  });

  it('reads the canonical heading with either bracket pair, and the name of a non-canonical agent heading', () => {
    expect(agentSectionId(agentSectionHeading('Juno', 'agt-1'))).toBe('agt-1');
    expect(agentSectionId('## Juno (agt-1)')).toBe('agt-1');
    expect(agentSectionId('## To confirm (ask once)')).toBeUndefined();
    expect(agentNameInHeading('## Agent: "Mint"')).toBe('Mint');
    expect(agentNameInHeading('## 助手：Mint')).toBe('Mint');
    expect(agentNameInHeading('## Agent')).toBe('');
    expect(agentNameInHeading('## Agents of change')).toBeUndefined();
    expect(agentNameInHeading('## Style')).toBeUndefined();
  });

  it('splits the evidence tags off a rule line', () => {
    expect(splitRuleTags('Keep it short. [claim:clm_a] [src:itm-1]')).toEqual({ text: 'Keep it short.', claimId: 'clm_a', sourceId: 'itm-1' });
    expect(splitRuleTags('Plain.')).toEqual({ text: 'Plain.' });
  });
});
