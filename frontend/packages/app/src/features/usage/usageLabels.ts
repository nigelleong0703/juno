import { formatCount, formatUsd } from "../../lib/format";

/** Shown in place of a value the service could not measure. */
export const NOT_AVAILABLE = "—";

/** A spend with an unknown price shows a dash, never a free $0.00. */
export function spendLabel(entry: { costUsd: number; costKnown?: boolean }): string {
  return entry.costKnown === false ? NOT_AVAILABLE : formatUsd(entry.costUsd);
}

/** Unmeasured counters are a dash, not a real zero. */
export function tokenLabel(entry: { measured?: boolean }, count: number): string {
  return entry.measured === false ? NOT_AVAILABLE : formatCount(count);
}

/** "1 run" / "3 runs". */
export function runsLabel(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "run" : "runs"}`;
}

/** The service reports a run whose model it could not tell as null or the word "unknown". */
export function isKnownModel(model: string | null | undefined): model is string {
  return model !== null && model !== undefined && model.trim() !== "" && model.toLowerCase() !== "unknown";
}

/** "6 Nov 2026, 02:25" in the viewer's locale, seconds dropped. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NOT_AVAILABLE;
  return date.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
