/**
 * Drift guard for the delivery split (BACKEND §3.3b): where a run's final text goes is stated in exactly one place, the two automatic-wake
 * notes, plus send_message's own description. Any other harness unit (system prompt sections, tool descriptions, wake and job texts) that
 * describes how a final reply is posted, or brings back a placeholder or a quiet-exit tool, contradicts one of the two rules.
 */
import { describe, expect, it } from 'vitest';
import { harnessSeedVersion } from '../loader.js';

const MAY_STATE_DELIVERY = new Set(['wake.automatic.nobody_waiting', 'wake.automatic.someone_waiting', 'tool.send_message']);

const BANNED: Array<[string, RegExp]> = [
  ['how a final reply is delivered', /final (reply|text|message)\b[^.]{0,50}\b(posted|delivered|sent|shown to)\b|\b(posted|delivered)\b[^.]{0,40}\bfinal (reply|text|message)/i],
  ['an empty-reply convention', /reply with nothing|empty reply|empty final|final reply (stays|is) empty|"\(empty\)"/i],
  ['the retired quiet exit', /finish_quietly|finish quietly|end (it|the \w+) (the )?quiet way/i],
  ['a placeholder ban', /never (write |use )?a placeholder|placeholder (reply|text)/i],
];

describe('delivery is described in one place', () => {
  const units = [...harnessSeedVersion().units.values()].filter((unit) => !MAY_STATE_DELIVERY.has(unit.id));

  it.each(BANNED)('no other unit states %s', (_what, pattern) => {
    const offenders = units.filter((unit) => pattern.test(unit.body)).map((unit) => unit.id);
    expect(offenders).toEqual([]);
  });

  it('the two statements and send_message are the places that do', () => {
    const files = harnessSeedVersion().units;
    expect(files.get('wake.automatic.nobody_waiting')?.body).toContain('your final text is not sent to anyone');
    expect(files.get('wake.automatic.someone_waiting')?.body).toContain('final reply is delivered');
    expect(files.get('tool.send_message')?.body).toContain('your final reply is delivered to this chat');
  });
});
