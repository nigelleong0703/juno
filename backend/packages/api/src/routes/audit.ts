/** Owner audit projection: read-only, written by execution in the private service. */
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ListQuery } from '@agent-desktop/contracts';
import { RUN_ORIGIN_TYPES } from '@agent-desktop/public-contracts';
import { createAppRepository } from '../app-repository.js';
import { AUDIT_CSV_HEADER, AUDIT_CSV_ROW_LIMIT, AUDIT_CSV_TRUNCATED_LINE, auditCsvRow } from '../modules/audit-csv.js';
import { requestOwner } from '../owner.js';
import { parseListQuery } from './list-query.js';
import type { AppRoutesDeps } from './index.js';

const auditFilterSchema = z.object({
  agentId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  /** The entry's `action`, e.g. `tool.policy` for tool authorization decisions (stored as the indexed kind). */
  action: z.string().min(1).optional(),
  /** The type of the root origin: who started the work. */
  initiator: z.enum(RUN_ORIGIN_TYPES as [string, ...string[]]).optional(),
  /** `true`: only unattended work; `false`: only work the owner started. */
  unattended: z.enum(['true', 'false']).optional(),
});

/** The audit filters as a store `where`; the list and the CSV export share them. */
function auditWhere(filter: z.infer<typeof auditFilterSchema>): NonNullable<ListQuery['where']> {
  return {
    ...(filter.agentId === undefined ? {} : { agentId: filter.agentId }),
    ...(filter.runId === undefined ? {} : { runId: filter.runId }),
    ...(filter.action === undefined ? {} : { kind: filter.action }),
    ...(filter.initiator === undefined ? {} : { initiator: filter.initiator }),
    ...(filter.unattended === undefined ? {} : { unattended: filter.unattended === 'true' }),
  };
}

/** List paging plus the audit filters. */
function auditQuery(raw: Record<string, string>, filter: z.infer<typeof auditFilterSchema>): ListQuery {
  const where = auditWhere(filter);
  return { ...parseListQuery(raw), ...(Object.keys(where).length === 0 ? {} : { where }) };
}

function invalidFilter(c: Context, error: z.ZodError): Response {
  return c.json({ error: { code: 'INVALID_AUDIT_FILTER', message: error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; ') } }, 400);
}

const EXPORT_PAGE = 500;

export function registerAudit(app: Hono, deps: AppRoutesDeps): void {
  app.get('/v1/audit', async (c: Context) => {
    const filter = auditFilterSchema.safeParse(c.req.query());
    if (!filter.success) return invalidFilter(c, filter.error);
    const repo = createAppRepository(deps.store, deps.blobs, requestOwner(c), deps.settingsUpdater);
    const page = await repo.activity.listAudit(auditQuery(c.req.query(), filter.data));
    return c.json({ items: page.items, nextCursor: page.nextCursor ?? null });
  });

  /** The same filters as the list, streamed as CSV one page at a time, newest first, at most AUDIT_CSV_ROW_LIMIT rows. */
  app.get('/v1/audit/export.csv', (c: Context) => {
    const filter = auditFilterSchema.safeParse(c.req.query());
    if (!filter.success) return invalidFilter(c, filter.error);
    const repo = createAppRepository(deps.store, deps.blobs, requestOwner(c), deps.settingsUpdater);
    const where = auditWhere(filter.data);
    const encoder = new TextEncoder();
    let sent = 0;
    let cursor: string | undefined;
    let started = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) {
          started = true;
          controller.enqueue(encoder.encode(AUDIT_CSV_HEADER));
        }
        const page = await repo.activity.listAudit({ limit: EXPORT_PAGE, ...(Object.keys(where).length === 0 ? {} : { where }), ...(cursor === undefined ? {} : { cursor }) });
        for (const entry of page.items) controller.enqueue(encoder.encode(auditCsvRow(entry)));
        sent += page.items.length;
        cursor = page.nextCursor;
        if (cursor === undefined) return controller.close();
        if (sent >= AUDIT_CSV_ROW_LIMIT) {
          controller.enqueue(encoder.encode(AUDIT_CSV_TRUNCATED_LINE));
          controller.close();
        }
      },
    });
    return c.body(body, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="juno-audit.csv"',
      'X-Export-Limit': String(AUDIT_CSV_ROW_LIMIT),
      'Cache-Control': 'no-store',
    });
  });
}
