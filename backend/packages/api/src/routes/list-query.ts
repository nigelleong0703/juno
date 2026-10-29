/**
 * Query parsing for the API-owned list endpoints. Same shape as the private service so a moved
 * route keeps its pagination contract; the API must not import agentd source.
 */
import { z } from 'zod';
import type { ListQuery } from '@agent-desktop/contracts';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  cursor: z.string().optional(),
  orderBy: z.enum(['at', 'id']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export function parseListQuery(honoQuery: Record<string, string>): ListQuery {
  const parsed = listQuerySchema.parse(honoQuery);
  return {
    limit: parsed.limit,
    cursor: parsed.cursor,
    orderBy: parsed.orderBy,
    order: parsed.order,
  };
}
