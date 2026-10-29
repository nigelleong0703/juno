/**
 * Typed browser helper wiring: the exact argv (port plus single-quoted request) and the strict
 * parsing of helper output (non-zero exits, missing helper, invalid JSON, schema mismatches).
 */
import { describe, expect, it } from 'vitest';
import { BROWSER_HELPER, browserCommand, parseBrowserOutput, type BrowserInput } from './browser.js';
import { BrowserDownError } from './errors.js';
import { screenPorts } from './ports.js';
import { shq } from './screen-boot.js';

describe('browser helper invocation', () => {
  it('targets the display CDP port with a single-quoted request, as root with root-only state', () => {
    const input: BrowserInput = { action: 'type', ref: 'e7', text: "o'clock" };
    const command = browserCommand(3, input);
    const port = screenPorts(3).cdp;
    expect(command).toBe(`AGENT_BROWSER_STATE=/run/juno/browser ${BROWSER_HELPER} --port ${port} --request ${shq(JSON.stringify(input))}`);
    expect(port).toBe(9222 + 3);
  });

  it('a fill_secret request is ciphertext only: the program text carries the sealed value and ids, never a plaintext', () => {
    const sealed = { epk: 'AAAA', nonce: 'BBBB', ciphertext: 'CCCC' };
    const command = browserCommand(3, { action: 'fill_secret', ref: 'e7', requestId: 'req1', fieldId: 'f1', sealed });
    expect(command).toContain(shq(JSON.stringify({ action: 'fill_secret', ref: 'e7', requestId: 'req1', fieldId: 'f1', sealed })));
    expect(command).not.toContain('JUNO_SECRET');
  });
});

describe('browser helper output', () => {
  it('reads a heading line without a role as a heading, not as an invalid snapshot', () => {
    // The helper writes headings as { heading, name } only (apple.com/sg/shop/buy-mac/mac-mini had 30 of them).
    const stdout = JSON.stringify({
      ok: true, action: 'snapshot', url: 'https://example.com/', title: 'Example', tab: 't1', crossOriginFrames: 0,
      nodes: [{ heading: 1, name: 'Buy Mac mini' }, { ref: 'e1', role: 'button', name: 'Select' }],
    });
    const result = parseBrowserOutput(stdout, '', 0, 'snapshot');
    expect(result.action === 'snapshot' && result.nodes[0]).toMatchObject({ role: 'heading', heading: 1, name: 'Buy Mac mini' });
  });

  it('parses a snapshot with its node refs', () => {
    const stdout = JSON.stringify({
      ok: true,
      action: 'snapshot',
      url: 'https://example.com/',
      title: 'Example',
      tab: 't1',
      nodes: [{ ref: 'e1', role: 'button', name: 'Search' }],
      crossOriginFrames: 0,
    });
    const result = parseBrowserOutput(stdout, '', 0, 'snapshot');
    if (result.action !== 'snapshot') throw new Error('expected a snapshot result');
    expect(result.url).toBe('https://example.com/');
    expect(result.nodes).toEqual([{ ref: 'e1', role: 'button', name: 'Search' }]);
  });

  it('parses page text without inventing fields', () => {
    const stdout = JSON.stringify({ ok: true, action: 'get_text', url: 'https://example.com/', title: 'Example', tab: 't1', text: 'hi' });
    const result = parseBrowserOutput(stdout, '', 0, 'get_text');
    if (result.action !== 'get_text') throw new Error('expected a text result');
    expect(result.text).toBe('hi');
  });

  it('fails truthfully on a non-zero exit with the helper stderr', () => {
    expect(() => parseBrowserOutput('', 'cdp: connection refused', 1, 'click')).toThrow(/cdp: connection refused/);
  });

  it('fails truthfully on invalid JSON and on a helper-reported error', () => {
    expect(() => parseBrowserOutput('not json', '', 0, 'snapshot')).toThrow(/invalid JSON/);
    const denied = JSON.stringify({ ok: false, error: 'ref node-9 is not visible' });
    expect(() => parseBrowserOutput(denied, '', 0, 'click')).toThrow(/not visible/);
  });

  it('rejects a result whose shape or action does not match the request', () => {
    const noNodes = JSON.stringify({ ok: true, action: 'snapshot', url: 'https://example.com/', title: 'Example' });
    expect(() => parseBrowserOutput(noNodes, '', 0, 'snapshot')).toThrow(/unexpected result/);
    const wrongAction = JSON.stringify({ ok: true, action: 'get_text', url: 'u', title: 't', tab: 't1', text: 'x' });
    expect(() => parseBrowserOutput(wrongAction, '', 0, 'snapshot')).toThrow(/get_text/);
  });
});

describe('browser result strictness', () => {
  it('requires the tab handle on snapshots so the model can address that tab again', () => {
    const stdout = JSON.stringify({ ok: true, action: 'snapshot', url: 'u', title: 't', nodes: [], crossOriginFrames: 0 });
    expect(() => parseBrowserOutput(stdout, '', 0, 'snapshot')).toThrow(/unexpected result/);
  });

  it('requires an explicit success flag on click and type side effects', () => {
    const click = JSON.stringify({ ok: true, action: 'click', url: 'u', title: 't', tab: 't1', clicked: false });
    expect(() => parseBrowserOutput(click, '', 0, 'click')).toThrow(/unexpected result/);
    const type = JSON.stringify({ ok: true, action: 'type', url: 'u', title: 't', tab: 't1' });
    expect(() => parseBrowserOutput(type, '', 0, 'type')).toThrow(/unexpected result/);
  });

  it('requires a title on navigate so a silent load is never acked', () => {
    const stdout = JSON.stringify({ ok: true, action: 'navigate', url: 'https://example.com/', tab: 't1' });
    expect(() => parseBrowserOutput(stdout, '', 0, 'navigate')).toThrow(/unexpected result/);
  });

  it('bounds snapshots and page text for model context', () => {
    const nodes = Array.from({ length: 241 }, (_, i) => ({ ref: `n-${i}`, role: 'link', name: 'x' }));
    const big = JSON.stringify({ ok: true, action: 'snapshot', url: 'u', title: 't', tab: 't1', nodes, crossOriginFrames: 0 });
    expect(() => parseBrowserOutput(big, '', 0, 'snapshot')).toThrow(/unexpected result/);
    const long = JSON.stringify({ ok: true, action: 'get_text', url: 'u', title: 't', tab: 't1', text: 'x'.repeat(20_001) });
    expect(() => parseBrowserOutput(long, '', 0, 'get_text')).toThrow(/unexpected result/);
  });

  it('reads a refused CDP port as a closed browser on that screen, not a generic failure', () => {
    const out = JSON.stringify({ ok: false, error: 'no CDP on 127.0.0.1:9224 (Connection refused)' });
    expect(() => parseBrowserOutput(out, '', 1, 'tabs')).toThrow(BrowserDownError);
    expect(() => parseBrowserOutput(out, '', 1, 'tabs')).toThrow('the browser on screen 2 closed; restarting');
    expect(() => parseBrowserOutput(out, '', 0, 'tabs')).toThrow(BrowserDownError);
  });
});
