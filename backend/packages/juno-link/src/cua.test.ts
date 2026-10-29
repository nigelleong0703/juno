import { describe, expect, it } from 'vitest';
import { runCuaDesktop, type CuaClient, type CuaResponse } from './cua.js';
import type { DesktopRequest } from './protocol.js';

interface Call { tool: string; args: Record<string, unknown>; image: boolean }

/** A fake cua-driver: one Notes window, a canned answer per tool. */
function fakeCua(answers: Partial<Record<string, CuaResponse>> = {}, windows?: unknown[]): { client: CuaClient; calls: Call[] } {
  const calls: Call[] = [];
  const defaults: Record<string, CuaResponse> = {
    list_windows: { isError: false, json: { windows: windows ?? [{ app_name: 'Notes', pid: 41, window_id: 7, title: 'Groceries', is_on_screen: true, on_current_space: true, z_index: 3 }] } },
    get_window_state: { isError: false, json: { snapshot_id: 's1', element_count: 2, tree_markdown: '- [0] AXWindow "Groceries"\n  - [1] AXTextArea' } },
    // The shape a real cua-driver returns: `failed_step` is always present, null on success.
    run_steps: { isError: false, json: { executed: 1, failed_step: null, ok: true, total: 1, steps: [{ index: 0, ok: true, tool: 'click', effect: 'confirmed' }] } },
    verify_state: { isError: false, json: { status: 'satisfied' } },
  };
  return {
    calls,
    client: {
      async call(tool, args, _signal, options) {
        calls.push({ tool, args, image: options?.image === true });
        const answer = answers[tool] ?? defaults[tool];
        if (answer === undefined) throw new Error('unexpected tool ' + tool);
        return answer;
      },
    },
  };
}

const request = (action: DesktopRequest['action'], input: Record<string, unknown>): DesktopRequest => ({ agentId: 'agent-1', action, input });
const signal = new AbortController().signal;

describe('cua snapshot', () => {
  it('reads the app window as a narrowed tree with no picture by default', async () => {
    const { client, calls } = fakeCua();
    const result = await runCuaDesktop(client, request('snapshot', { app: 'Notes', query: 'Groceries' }), signal);
    expect(result.ok).toBe(true);
    expect(result.text).toContain('Notes — "Groceries" (window 7) · snapshot s1');
    expect(result.text).toContain('AXTextArea');
    expect(result.image).toBeUndefined();
    expect(calls.map((c) => c.tool)).toEqual(['list_windows', 'get_window_state']);
    expect(calls[1]?.args).toMatchObject({ pid: 41, window_id: 7, query: 'Groceries', include_screenshot: false, session: 'agent-1' });
  });

  it('adds a small picture when asked, and when the tree is empty or degraded', async () => {
    const asked = fakeCua();
    expect((await runCuaDesktop(asked.client, request('snapshot', { app: 'Notes', screenshot: true }), signal)).image).toBeUndefined();
    const image = { mimeType: 'image/png', data: 'AAAA' };
    const withShot = fakeCua({ get_window_state: { isError: false, image, json: { snapshot_id: 's2', element_count: 2, tree_markdown: '- [0] AXWindow' } } });
    const shot = await runCuaDesktop(withShot.client, request('snapshot', { app: 'Notes', screenshot: true }), signal);
    expect(shot.image).toEqual(image);
    expect(withShot.calls[2]).toMatchObject({ tool: 'get_window_state', image: true, args: { include_accessibility_tree: false, max_dimension: 900 } });

    const empty = fakeCua({ get_window_state: { isError: false, image, json: { snapshot_id: 's3', element_count: 0, tree_markdown: '', degraded_reason: 'ax_window_unresolved' } } });
    const degraded = await runCuaDesktop(empty.client, request('snapshot', { app: 'Notes' }), signal);
    expect(degraded.text).toContain('No usable elements (ax_window_unresolved)');
    expect(degraded.image).toEqual(image);
  });

  it('matches the app by exact name or bundle id, never a substring', async () => {
    const two = [
      { app_name: 'Notes', pid: 41, window_id: 7, title: 'a', is_on_screen: true },
      { app_name: 'Notion', pid: 52, window_id: 9, title: 'b', is_on_screen: true },
    ];
    const exact = fakeCua({}, two);
    expect((await runCuaDesktop(exact.client, request('snapshot', { app: 'notes' }), signal)).ok).toBe(true);
    expect(exact.calls[1]?.args).toMatchObject({ pid: 41 });
    const partial = fakeCua({}, two);
    const refused = await runCuaDesktop(partial.client, request('snapshot', { app: 'Not' }), signal);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.text).toContain('no open window');
    const bundles = fakeCua({}, two);
    expect((await runCuaDesktop(bundles.client, request('snapshot', { app: 'com.apple.Notes' }), signal)).text).toContain('more than one app');
  });
});

describe('cua act', () => {
  const steps = [{ tool: 'click', args: { element_token: 's1:1' } }, { tool: 'type_text', args: { text: 'milk' } }];

  it('runs the steps in the background in one run_steps call and observes', async () => {
    const { client, calls } = fakeCua();
    const result = await runCuaDesktop(client, request('act', { app: 'Notes', steps }), signal);
    expect(result).toMatchObject({ ok: true });
    expect(result.needsForeground).toBeUndefined();
    expect(calls[1]).toMatchObject({ tool: 'run_steps', args: { pid: 41, window_id: 7, steps, observe: {} } });
    expect(calls[1]?.args).not.toHaveProperty('delivery_mode');
  });

  it('says when the app only takes the input in front, and delivers in front only when told to', async () => {
    const refusal: CuaResponse = { isError: true, json: { ok: false, failed_step: 1, error: { code: 'background_unavailable', hint: 'bring it forward' } } };
    const first = fakeCua({ run_steps: refusal });
    expect(await runCuaDesktop(first.client, request('act', { app: 'Notes', steps }), signal)).toMatchObject({ ok: false, needsForeground: true });
    const second = fakeCua({ run_steps: refusal });
    const forced = await runCuaDesktop(second.client, request('act', { app: 'Notes', steps, foreground: true }), signal);
    expect(second.calls[1]?.args).toMatchObject({ delivery_mode: 'foreground' });
    expect(forced.needsForeground).toBeUndefined();
  });

  it('reports a failed step and an effect that could not be confirmed as what they are', async () => {
    const failed = fakeCua({ run_steps: { isError: false, json: { failed_step: 2, steps: [{ ok: true }, { ok: false, error: 'stale_element_token' }] } } });
    const result = await runCuaDesktop(failed.client, request('act', { app: 'Notes', steps }), signal);
    expect(result.ok).toBe(false);
    expect(result.text).toContain('stale_element_token');
  });

  it('refuses steps that retarget another app, pick the delivery, or use a non-action tool, before anything runs', async () => {
    for (const bad of [
      [{ tool: 'click', args: { app: 'Mail', x: 1, y: 1 } }],
      [{ tool: 'click', args: { pid: 1, x: 1, y: 1 } }],
      [{ tool: 'click', args: { x: 1, y: 1, delivery_mode: 'foreground' } }],
      [{ tool: 'get_window_state', args: {} }],
      [{ tool: 'kill_app', args: { pid: 41 } }],
      [],
    ]) {
      const { client, calls } = fakeCua();
      const result = await runCuaDesktop(client, request('act', { app: 'Notes', steps: bad }), signal);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
      expect(calls.some((c) => c.tool === 'run_steps')).toBe(false);
    }
  });
});

describe('cua verify', () => {
  it('is ok only when the predicates are satisfied; unknown is not success', async () => {
    const expectation = [{ element: { selector: { role: 'AXTextArea' }, exists: true } }];
    const { client, calls } = fakeCua();
    expect(await runCuaDesktop(client, request('verify', { app: 'Notes', expect: expectation }), signal)).toMatchObject({ ok: true });
    expect(calls[1]).toMatchObject({ tool: 'verify_state', args: { pid: 41, window_id: 7, expect: expectation } });
    const unknown = fakeCua({ verify_state: { isError: false, json: { status: 'unknown' } } });
    expect((await runCuaDesktop(unknown.client, request('verify', { app: 'Notes', expect: expectation }), signal)).ok).toBe(false);
  });
});
