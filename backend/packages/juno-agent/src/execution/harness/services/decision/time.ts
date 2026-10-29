/** Time zone helpers for the delegation window: an instant seen in a zone, and a zone's wall-clock time as an instant. */

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The weekday (0 = Sunday) and minutes since midnight of an instant in a zone. */
export function localClock(at: Date, tz: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: string): string => parts.find((entry) => entry.type === type)?.value ?? '';
  return { day: WEEKDAYS[part('weekday')] ?? 0, minutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

function zoneOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const n = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(at.getTime() / 1000) * 1000;
}

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * The instant a calendar-style value names, as ISO: it must carry an offset, or be a local date-time with the zone it is in.
 * Anything else is ambiguous and gives undefined (a window can then not be checked).
 */
export function instantOf(value: string, timeZone?: string): string | undefined {
  const text = value.trim();
  if (HAS_OFFSET.test(text)) {
    const time = Date.parse(text);
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
  }
  const match = LOCAL_DATE_TIME.exec(text);
  if (match === null || timeZone === undefined || !validTimeZone(timeZone)) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  const instant = guess - zoneOffsetMs(new Date(first), timeZone);
  return new Date(instant).toISOString();
}
