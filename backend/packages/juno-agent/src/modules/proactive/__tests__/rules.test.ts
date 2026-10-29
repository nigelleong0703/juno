/** The proactive rules file: fixed format round trip, the one-time conversion of an old free-text file, review dates, and the hard-rule match. */
import { describe, expect, it } from 'vitest';
import { addRule, blockingRule, dueForReview, keepRule, parseRules, renderRules, rulesText, toPublicRule, LEGACY_SOURCE } from '../rules.js';

const TODAY = '2026-10-23';

describe('proactive rules format', () => {
  it('round-trips every kind, with the source kept verbatim even when it holds quotes, pipes and newlines', () => {
    let rules = addRule([], { kind: 'dont', scope: 'topic', text: 'Cricket scores', source: '"stop telling me about cricket"' }, TODAY).rules;
    rules = addRule(rules, { kind: 'less', scope: 'type', text: 'Daily word', source: 'Less pressed on a Feed post: "Word | of the\nday"' }, TODAY).rules;
    rules = addRule(rules, { kind: 'tell', scope: 'topic', text: 'Flight delays', source: '"do tell me about flight delays"' }, TODAY).rules;
    rules = addRule(rules, { kind: 'where', scope: 'frequency', text: 'Digest in the Feed, once a week', source: '"put that in the Feed"' }, TODAY).rules;
    const text = renderRules(rules);
    expect(text).toContain("## Don't tell me\n- Cricket scores | id: ");
    expect(text).toContain('| scope: type | date: 2026-10-23 | review: 2027-01-21 | source: ');
    const back = parseRules(text);
    expect(back.legacy).toBe(false);
    // The file groups rules by section; the rules themselves come back unchanged.
    expect(back.rules).toHaveLength(rules.length);
    for (const rule of rules) expect(back.rules).toContainEqual(rule);
    expect(back.rules.find((rule) => rule.kind === 'less')?.source).toBe('Less pressed on a Feed post: "Word | of the day"');
  });

  it('adds the same rule once, and strips separator characters from the text', () => {
    const first = addRule([], { kind: 'dont', scope: 'topic', text: 'Cricket | scores', source: 'a' }, TODAY);
    const second = addRule(first.rules, { kind: 'dont', scope: 'topic', text: 'cricket scores!', source: 'b' }, TODAY);
    expect(first.rule.text).toBe('Cricket / scores');
    expect(second.added).toBe(false);
    expect(second.rules).toHaveLength(1);
  });

  it('gives only soft rules a review date: 90 days, due once it passes, still listed and applied, bumped by keep', () => {
    const rules = addRule(addRule([], { kind: 'dont', scope: 'topic', text: 'Politics', source: 'a' }, TODAY).rules, { kind: 'less', scope: 'topic', text: 'Football', source: 'b' }, TODAY).rules;
    const never = rules.find((rule) => rule.kind === 'dont');
    const soft = rules.find((rule) => rule.kind === 'less');
    expect(never?.review).toBeUndefined();
    expect(soft?.review).toBe('2027-01-21');
    expect(dueForReview(soft!, '2027-01-20')).toBe(false);
    expect(dueForReview(soft!, '2027-01-21')).toBe(true);
    expect(dueForReview(never!, '2030-01-01')).toBe(false);
    expect(toPublicRule(soft!, '2027-02-01')).toMatchObject({ strength: 'less', dueForReview: true });
    expect(toPublicRule(never!, '2027-02-01')).toMatchObject({ strength: 'never', dueForReview: false });
    expect(rulesText(rules, '2027-02-01')).toContain('Football (topic, due for review: still applies)');
    const kept = keepRule(rules, soft!.id, '2027-02-01');
    expect(kept?.rule.review).toBe('2027-05-02');
    expect(keepRule(rules, never!.id, '2027-02-01')).toBeUndefined();
  });

  it('converts an old free-text file once: Never lines become never rules, the rest tell/where rules, hints and headings dropped', () => {
    const legacy = [
      '# Proactive preferences', '',
      '## Tell me about', '*What is worth interrupting me for.*', 'Air quality hazards', '- Deadlines', '',
      '## Never tell me about', '*Topics you must not message me about.*', 'Football', '',
      '## How', 'Short, in the Feed', '',
    ].join('\n');
    const parsed = parseRules(legacy);
    expect(parsed.legacy).toBe(true);
    expect(parsed.rules.map((rule) => [rule.kind, rule.text, rule.source])).toEqual([
      ['tell', 'Air quality hazards', LEGACY_SOURCE], ['tell', 'Deadlines', LEGACY_SOURCE], ['dont', 'Football', LEGACY_SOURCE], ['where', 'Short, in the Feed', LEGACY_SOURCE],
    ]);
    // Converting twice gives the same ids, and the rewritten file is no longer legacy.
    expect(parseRules(legacy).rules.map((rule) => rule.id)).toEqual(parsed.rules.map((rule) => rule.id));
    expect(parseRules(renderRules(parsed.rules))).toEqual({ rules: parsed.rules, legacy: false });
    expect(parseRules('').rules).toEqual([]);
  });

  it('matches a hard rule against a candidate by the rule\'s content words only', () => {
    const rules = addRule(addRule([], { kind: 'dont', scope: 'topic', text: 'Cricket scores', source: 'a' }, TODAY).rules, { kind: 'less', scope: 'topic', text: 'Chess', source: 'b' }, TODAY).rules;
    expect(blockingRule(rules, 'IPL cricket scores for tonight')?.text).toBe('Cricket scores');
    expect(blockingRule(rules, 'Cricket tickets')).toBeUndefined();
    expect(blockingRule(rules, 'Chess openings')).toBeUndefined();
  });
});
