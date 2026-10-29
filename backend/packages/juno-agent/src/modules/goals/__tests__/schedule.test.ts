import { describe, expect, it } from 'vitest';
import type { Goal } from '@agent-desktop/public-contracts';
import { checkinText } from '../checkin.js';
import { briefingDue, clampNextCheck, dueDeadlines, isCheckinDue } from '../schedule.js';

const now = new Date('2026-10-15T10:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetMs: number): string => new Date(now.getTime() + offsetMs).toISOString();
const goal = (patch: Partial<Goal> = {}): Goal => ({ id: 'g1', agentId: 'a', kind: 'goal', title: 'Ship it', summary: '', status: 'active', createdAt: iso(-HOUR), updatedAt: iso(-HOUR), ...patch });

describe('goal check-in schedule', () => {
  it('keeps the next check between one hour and seven days, one day by default', () => {
    expect(clampNextCheck(undefined, now)).toBe(iso(24 * HOUR));
    expect(clampNextCheck('nonsense', now)).toBe(iso(24 * HOUR));
    expect(clampNextCheck(iso(60_000), now)).toBe(iso(HOUR));
    expect(clampNextCheck(iso(-5 * HOUR), now)).toBe(iso(HOUR));
    expect(clampNextCheck(iso(3 * HOUR), now)).toBe(iso(3 * HOUR));
    expect(clampNextCheck(iso(30 * 24 * HOUR), now)).toBe(iso(7 * 24 * HOUR));
  });

  it('checks only active goals whose time has come', () => {
    expect(isCheckinDue(goal({ nextCheckAt: iso(-1) }), now)).toBe(true);
    expect(isCheckinDue(goal({ nextCheckAt: iso(HOUR) }), now)).toBe(false);
    expect(isCheckinDue(goal({ nextCheckAt: iso(-1), status: 'paused' }), now)).toBe(false);
    expect(isCheckinDue(goal({ nextCheckAt: iso(-1), status: 'done' }), now)).toBe(false);
  });

  it('finds unreminded milestones due within 24 hours, once', () => {
    const milestones: Goal['milestones'] = [
      { id: 'soon', title: 'Draft', status: 'doing', due: iso(23 * HOUR) },
      { id: 'later', title: 'Review', status: 'todo', due: iso(40 * HOUR) },
      { id: 'done', title: 'Outline', status: 'done', due: iso(HOUR) },
      { id: 'sent', title: 'Send', status: 'todo', due: iso(HOUR), remindedAt: iso(-HOUR) },
    ];
    expect(dueDeadlines(goal({ milestones }), now).map((m) => m.id)).toEqual(['soon']);
    expect(dueDeadlines(goal({ milestones, status: 'paused' }), now)).toEqual([]);
  });

  it('tells the agent to message only for a deadline, a real change or a decision', () => {
    const near = goal({ milestones: [{ id: 'm', title: 'Send taxes', status: 'todo', due: iso(5 * HOUR) }] });
    expect(checkinText(near, 'scheduled', now)).toContain('Due within 24 hours: Send taxes. Tell the user.');
    expect(checkinText(goal(), 'scheduled', now)).not.toContain('Due within 24 hours');
    expect(checkinText(goal(), 'scheduled', now)).toContain('ONLY if something really changed');
    expect(checkinText(near, 'deadline', now)).toContain('You MUST tell the user');
  });

  it('writes the briefing once per local day, from 6 a.m.', () => {
    expect(briefingDue(new Date('2026-10-15T05:00:00Z'), 'UTC', undefined).due).toBe(false);
    expect(briefingDue(new Date('2026-10-15T07:00:00Z'), 'UTC', undefined)).toEqual({ due: true, date: '2026-10-15' });
    expect(briefingDue(new Date('2026-10-15T07:00:00Z'), 'UTC', '2026-10-15').due).toBe(false);
    expect(briefingDue(new Date('2026-10-15T07:00:00Z'), 'Asia/Tokyo', undefined).due).toBe(true);
  });
});
