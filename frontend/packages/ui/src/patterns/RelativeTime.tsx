import { cn } from "@/lib/utils";

export interface RelativeTimeProps {
  date: Date | number | string;
  /** Reference point; defaults to now. */
  now?: Date | number;
  className?: string;
  title?: string;
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 1000 * 60 * 60 * 24 * 365],
  ["month", 1000 * 60 * 60 * 24 * 30],
  ["week", 1000 * 60 * 60 * 24 * 7],
  ["day", 1000 * 60 * 60 * 24],
  ["hour", 1000 * 60 * 60],
  ["minute", 1000 * 60],
  ["second", 1000],
];

/** Format a date relative to now, e.g. "3 hours ago" / "in 2 days". */
export function RelativeTime({ date, now, className, title }: RelativeTimeProps) {
  const parsed = date instanceof Date ? date : new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    return (
      <time data-slot="relative-time" className={cn("text-muted-foreground", className)}>
        Invalid date
      </time>
    );
  }

  // Reading the clock is this component's purpose; it is not a render-stability bug.
  // eslint-disable-next-line react-hooks/purity
  const clockNow = Date.now();
  const reference = now === undefined ? clockNow : now instanceof Date ? now.getTime() : now;
  const deltaMs = parsed.getTime() - reference;
  const absMs = Math.abs(deltaMs);

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  let rendered = formatter.format(0, "second");
  for (const [unit, ms] of UNITS) {
    if (absMs >= ms || unit === "second") {
      rendered = formatter.format(Math.round(deltaMs / ms), unit);
      break;
    }
  }

  return (
    <time
      data-slot="relative-time"
      dateTime={parsed.toISOString()}
      title={title ?? parsed.toLocaleString()}
      className={cn("text-muted-foreground", className)}
    >
      {rendered}
    </time>
  );
}
