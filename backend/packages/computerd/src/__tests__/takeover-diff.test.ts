import { describe, expect, it } from 'vitest';
import { diffSnapshots } from '../modules/computers/takeover.js';

const tab = (t: string, url: string, title = '') => ({ tab: t, url, title });

describe('takeover diff', () => {
  it('reports a restarted browser instead of a per-tab diff, and nothing when unchanged', () => {
    const tabs = [tab('t1', 'https://a.test/', 'A')];
    expect(diffSnapshots({ pid: '10', tabs }, { pid: '11', tabs })[0]).toMatch(/^browser was closed and restarted; tabs now: t1 https:\/\/a.test\//);
    expect(diffSnapshots({ pid: '10', tabs }, { pid: '10', tabs })).toEqual([]);
    expect(diffSnapshots({ pid: '10', tabs }, {})).toEqual(['the browser state could not be read']);
  });
});
