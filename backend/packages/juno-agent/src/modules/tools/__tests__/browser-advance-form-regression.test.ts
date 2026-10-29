import { describe, expect, it } from 'vitest';
import { buildCandidates } from '../computer/browser-advance-candidates.js';
import { createAdvanceView, orderedCandidates } from '../computer/browser-advance-views.js';
import { askDecision, decisionState } from '../computer/browser-advance-decision.js';
import type { AdvanceObservation, RunBrowserAdvanceOptions } from '../computer/browser-advance-types.js';

function observation(): AdvanceObservation {
  return { page: { action: 'snapshot', tab: 't1', url: 'https://fixture.invalid/', title: 'Booking search', crossOriginFrames: 0, nodes: [
    ...Array.from({ length: 64 }, (_, i) => ({ ref: 'nav' + i, role: 'link', name: 'Help topic ' + i })),
    { ref: 'from', role: 'combobox', name: 'Origin', value: 'Example city' },
    { ref: 'date', role: 'textbox', name: 'Departure', state: ['readonly'] },
    { ref: 'return', role: 'textbox', name: 'Return', state: ['readonly'] },
    { ref: 'submit', role: 'button', name: 'Search' },
  ] } };
}
function options(): RunBrowserAdvanceOptions {
  return { args: { goal: 'Choose travel dates and search' }, ownerId: 'o', agentId: 'a', conversationId: 'c', runId: 'r', signal: new AbortController().signal,
    journal: async (_key, action) => action(), execute: async () => { throw new Error('No browser effect in this regression'); } };
}

describe('native browser form discovery', () => {
  it('keeps the form state visible after a long navigation list', () => {
    const page = observation();
    const state = JSON.parse(decisionState(options(), page, orderedCandidates(page, buildCandidates(page, {}), {}), []));
    expect(state.observation.controls).toContainEqual(expect.objectContaining({ ref: 'from', value: 'Example city' }));
    expect(state.observation.controls).toContainEqual(expect.objectContaining({ ref: 'date', state: ['readonly'] }));
  });
  it('offers a readonly date field as an observed click target without authorizing invented typing', () => {
    const candidates = buildCandidates(observation(), {});
    expect(candidates).toContainEqual(expect.objectContaining({ action: expect.objectContaining({ kind: 'click', ref: 'date' }) }));
    expect(candidates.some(c => c.action.kind === 'type')).toBe(false);
  });
  it('keeps every observed action reachable through bounded recursive ranges', () => {
    const page = observation();
    page.page.nodes = Array.from({ length: 240 }, (_, i) => ({ ref: 'field' + i, role: 'textbox', name: 'Field ' + i }));
    const values = Object.fromEntries(page.page.nodes.map(node => [node.name, 'known value']));
    const candidates = buildCandidates(page, values);
    const reached = new Set<string>();
    const visit = (view: ReturnType<typeof createAdvanceView>): void => {
      expect(view.candidates.length).toBeLessThanOrEqual(24);
      expect(view.groups.length).toBeLessThanOrEqual(8);
      for (const candidate of view.candidates) {
        expect(reached.has(candidate.key)).toBe(false);
        reached.add(candidate.key);
      }
      for (const group of view.groups) visit(createAdvanceView(candidates, group.range));
    };
    visit(createAdvanceView(candidates));
    expect(reached.size).toBe(candidates.length);
  });
  it('includes exact supplied values when grouped fill is disclosed without individual type options', () => {
    const page = observation();
    page.page.nodes = [{ ref: 'a', role: 'textbox', name: 'Name' }, { ref: 'b', role: 'textbox', name: 'City' }];
    const candidates = buildCandidates(page, { Name: 'Mia', City: 'Singapore' });
    const fill = candidates.find(candidate => candidate.action.kind === 'fill');
    if (fill === undefined) throw new Error('Missing grouped fill');
    const state = JSON.parse(decisionState(options(), page, [fill], []));
    expect(state.main_supplied_values).toEqual([{ label: 'Name', value: 'Mia', truncated: false }, { label: 'City', value: 'Singapore', truncated: false }]);
    expect(state.observation.controls.map((node: {ref: string}) => node.ref)).toEqual(['a', 'b']);
  });
  it('reports a valid native DEFER as a handoff instead of a rejected browser mutation', async () => {
    const page = observation();
    const candidates = buildCandidates(page, {});
    const opts = options();
    opts.systemOne = { async ask(_state, questions) {
      const question = questions['action'];
      if (question?.type !== 'choice') throw new Error('Expected choice');
      const probabilities = Object.fromEntries(Object.keys(question.options).map(key => [key, 0]));
      probabilities['DEFER'] = .77; probabilities['READ'] = .23;
      return { action: { type: 'choice', choice: 'DEFER', probabilities, confidence: .77 } };
    } };
    expect((await askDecision(opts, page, candidates, [])).record).toMatchObject({ kind: 'chosen', key: 'DEFER', probability: .77 });
  });
});
