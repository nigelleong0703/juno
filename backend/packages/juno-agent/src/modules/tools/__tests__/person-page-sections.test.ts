/**
 * A person page is shared by the owner's agents, but each `## <name>（<id>）` section holds that agent's private lines (BACKEND 5.7.4):
 * files.read shows an agent its own sections only, and leaves the rest of the page as it is.
 */
import { describe, expect, it } from 'vitest';
import { HOME_ROOT } from '../../home/paths.js';
import { visibleFileText } from '../tools/homeGuard.js';

const PAGE = [
  '# Priya',
  '- Shared line about Priya.',
  '## Mint（agt-mint）',
  '- Mint private note.',
  '## Atlas（agt-atlas）',
  '- Atlas private note.',
  '',
].join('\n');

describe('visibleFileText', () => {
  it('shows a person page to an agent without the other agents\' sections', () => {
    const seen = visibleFileText(`${HOME_ROOT}/people/per_0123abcd.md`, PAGE, 'agt-atlas');
    expect(seen).toContain('- Shared line about Priya.');
    expect(seen).toContain('## Atlas（agt-atlas）');
    expect(seen).toContain('- Atlas private note.');
    expect(seen).not.toContain('Mint private note.');
    expect(seen).not.toContain('## Mint（agt-mint）');
  });

  it('leaves every other file as it is, whatever it says', () => {
    const other = '## Mint（agt-mint）\n- not a person page\n';
    expect(visibleFileText(`${HOME_ROOT}/memory/2026-10-26/agt-atlas.md`, other, 'agt-atlas')).toBe(other);
    expect(visibleFileText('/workspace/notes.md', other, 'agt-atlas')).toBe(other);
  });
});
