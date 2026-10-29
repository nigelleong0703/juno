/**
 * Query parameter parsing helpers for list endpoints.
 * Converts Hono query objects to typed ListQuery objects.
 */

import { z } from 'zod';
import type { ListQuery } from '@agent-desktop/contracts';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  cursor: z.string().optional(),
  orderBy: z.enum(['at', 'id']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

const indexedFieldsSchema = z.object({
  agentId: z.string().optional(),
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  status: z.string().optional(),
  kind: z.string().optional(),
  parentId: z.string().optional(),
  ids: z.array(z.string()).optional(),
});

/**
 * Parse Hono query params to ListQuery.
 * Hono's c.req.query() returns Record<string, string>.
 */
export function parseListQuery(honoQuery: Record<string, string>): ListQuery {
  const parsed = listQuerySchema.parse(honoQuery);
  return {
    limit: parsed.limit,
    cursor: parsed.cursor,
    orderBy: parsed.orderBy,
    order: parsed.order,
  };
}

/**
 * Parse query params to ListQuery with indexed field filters.
 */
export function parseListQueryWithWhere(honoQuery: Record<string, string>, fields: string[]): ListQuery {
  const listPart = parseListQuery(honoQuery);
  const wherePart: Record<string, string | string[] | undefined> = {};

  for (const field of fields) {
    if (field === 'ids' && honoQuery.ids) {
      wherePart[field] = honoQuery.ids.split(',');
    } else if (field !== 'ids' && field in honoQuery && honoQuery[field]) {
      wherePart[field] = honoQuery[field];
    }
  }

  const where = indexedFieldsSchema.partial().parse(wherePart);

  return {
    ...listPart,
    where: Object.keys(where).length > 0 ? where : undefined,
  };
}
