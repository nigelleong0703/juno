import { describe, expect, it } from 'vitest';
import { requestSchema } from '@agent-desktop/public-contracts';
import { parseStoredRequest, toPublicRequest } from '../requests.js';
import type { Request } from '@agent-desktop/public-contracts';

const base: Request = {
  id: 'req-1',
  kind: 'approval',
  status: 'approved',
  title: 'Send email',
  summary: 'Send it',
  agentId: 'agent-1',
  createdAt: '2026-10-06T00:00:00.000Z',
  payload: { kind: 'approval', action: 'Send email', why: 'asked' },
};

describe('stored request internals', () => {

  it('parses valid internal fields', () => {
    const stored = parseStoredRequest({
      ...base,
      awakeableId: 'awk-1',
      wakeDeliveredAt: '2026-10-06T00:00:01.000Z',
      resolution: { action: 'approve', note: 'ok' },
    } as Request);
    expect(stored.awakeableId).toBe('awk-1');
    expect(stored.wakeDeliveredAt).toBe('2026-10-06T00:00:01.000Z');
    expect(stored.resolution).toEqual({ action: 'approve', note: 'ok' });
  });

  it('drops malformed internal fields instead of failing the document', () => {
    const stored = parseStoredRequest({ ...base, awakeableId: '', wakeDeliveredAt: 5, resolution: { action: 'nope' } } as unknown as Request);
    expect(stored.awakeableId).toBeUndefined();
    expect(stored.wakeDeliveredAt).toBeUndefined();
    expect(stored.resolution).toBeUndefined();
    expect(stored.id).toBe('req-1');
  });

  it('toPublicRequest removes every internal field and keeps the rest', () => {
    const pub = toPublicRequest({ ...base, awakeableId: 'awk-1', wakeDeliveredAt: 'x', resolution: { action: 'approve' }, tool: 'mcp.abc.send_email_1' } as Request);
    // A decided approval also gets its derived outcome words (0.22.0), which is never stored.
    expect(pub).toEqual({ ...base, outcome: 'allowed_once' });
    expect(requestSchema.parse(pub)).toEqual({ ...base, outcome: 'allowed_once' });
    expect(parseStoredRequest(pub)).not.toHaveProperty('outcome');
  });
});
