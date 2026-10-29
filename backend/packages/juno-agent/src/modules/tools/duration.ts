/** Parse the complete duration, retaining the legacy unitless millisecond form. */
export function durationMs(value: string): number {
  const match = /^\+?(\d+)(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) throw new Error('Expected a positive duration, such as +2m, 1h or 5000 milliseconds');
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const result = Number(match[1]) * (units[match[2] ?? 'ms'] ?? 1);
  if (!Number.isSafeInteger(result) || result <= 0 || !Number.isFinite(Date.now() + result) || Date.now() + result > 8.64e15) {
    throw new Error('Duration must be positive and produce a valid timestamp');
  }
  return result;
}
