/**
 * Audit export rows as CSV (RFC 4180: CRLF line ends, a cell is quoted when it holds a comma, quote or line break, quotes doubled).
 * Entries carry text a stranger can influence (a tool target, a reason), so a cell a spreadsheet would read as a formula gets a leading
 * apostrophe, which spreadsheets show as plain text.
 */
import type { AuditEntry } from '@agent-desktop/public-contracts';

/** The fixed column set, in order. `agent` and `rule` are ids. */
export const AUDIT_CSV_COLUMNS = ['at', 'agent', 'action', 'target', 'decision', 'reason', 'rule', 'initiator', 'unattended', 'runId', 'requestId'] as const;

/** Rows in one export. The newest rows come first, so a capped export is the most recent history. */
export const AUDIT_CSV_ROW_LIMIT = 10_000;

export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
}

function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(',') + '\r\n';
}

export const AUDIT_CSV_HEADER = csvLine(AUDIT_CSV_COLUMNS);

export function auditCsvRow(entry: AuditEntry): string {
  return csvLine([
    entry.at,
    entry.agentId ?? '',
    entry.action,
    entry.target ?? '',
    entry.decision,
    entry.reason,
    entry.ruleId ?? '',
    entry.initiator.type,
    String(entry.unattended),
    entry.runId ?? '',
    entry.requestId ?? '',
  ]);
}

/** Trailing line of a capped export. It is a comment line, not a row: the file is complete up to it. */
export const AUDIT_CSV_TRUNCATED_LINE = `# truncated: the newest ${String(AUDIT_CSV_ROW_LIMIT)} rows are shown; narrow the filters for the rest\r\n`;
