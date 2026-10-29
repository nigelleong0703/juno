/** Small formatting helpers shared across feature pages. */

/** "3m 20s" / "1h 04m" / "45s" from a millisecond duration. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** "12.4 KB" from a byte count. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** "$4.12" from a USD amount. */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** "1,240" — thousands-separated integer. */
export function formatCount(value: number): string {
  return new Intl.NumberFormat("en").format(Math.round(value));
}

/** Uptime from seconds: "3d 4h" / "5h 20m" / "12m". */
export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Truncate a long string to `max` characters with an ellipsis. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** First letters of a name, for avatar / member fallbacks. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
}

/**
 * Compact chat-list timestamp (VISUAL.md "Sidebar chat rows"): the time for today, "Yesterday"
 * for the day before, the weekday within the last week, and a short date beyond that — the
 * density iMessage/WeChat-style lists use, rather than a full relative phrase.
 */
export function formatChatTime(value: string | number | Date, now: Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);

  if (days <= 0) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

/** The transcript's day divider: Today, Yesterday, the weekday inside a week, else a short date (iPhone rules). */
export function formatDaySeparator(
  value: string | number | Date,
  labels: { today: string; yesterday: string },
  now: Date = new Date(),
): string {
  const date = value instanceof Date ? value : new Date(value);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return labels.today;
  if (days === 1) return labels.yesterday;
  if (days > 1 && days < 7) return date.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

/** The iPhone's short relative time: "now", "5m ago", "2h ago", "3d ago", "2w ago", "4mo ago", "1y ago". */
export function formatAgo(value: string | number | Date | undefined, now: number = Date.now()): string {
  if (value === undefined) return "";
  const time = (value instanceof Date ? value : new Date(value)).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
