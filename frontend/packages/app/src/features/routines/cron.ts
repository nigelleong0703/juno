import cronstrue from "cronstrue";

/** A friendly schedule preset: the raw cron plus the words shown before it is saved. */
export interface SchedulePreset {
  id: string;
  label: string;
  /** Empty for the "Custom" entry, which reveals the raw cron field. */
  cron: string;
  /** Short human phrase stored on the trigger (`RoutineTrigger.human`). */
  human: string;
}

/** The presets offered before a user reaches for raw cron (§4.6). */
export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: "weekdays-9", label: "Every weekday at 9:00", cron: "0 9 * * 1-5", human: "Weekdays 9:00" },
  { id: "daily-8", label: "Every day at 8:00", cron: "0 8 * * *", human: "Every day 8:00" },
  { id: "monday-9", label: "Every Monday at 9:00", cron: "0 9 * * 1", human: "Mondays 9:00" },
  { id: "hourly", label: "Every hour", cron: "0 * * * *", human: "Every hour" },
  { id: "custom", label: "Custom schedule…", cron: "", human: "Custom schedule" },
];

/** A short, curated timezone list — enough for the defaults without shipping the tz database. */
export const TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

/** Local wall-clock timezone, used as the default when a routine has none. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Turn a raw cron expression into words ("At 09:00, Monday through Friday"). Undefined if it
 * cannot be parsed, so the UI can fall back to showing the raw expression. */
export function describeCron(cron: string): string | undefined {
  const value = cron.trim();
  if (!value) return undefined;
  try {
    return cronstrue.toString(value, { use24HourTimeFormat: true });
  } catch {
    return undefined;
  }
}

/** Match a cron expression back to one of the presets, if it is one. */
export function presetForCron(cron: string): SchedulePreset | undefined {
  return SCHEDULE_PRESETS.find((preset) => preset.cron && preset.cron === cron.trim());
}
