/**
 * TOOL_CALL_ARGS.delta is a complete JSON document: a standard consumer parses it to reconstruct
 * the call. Oversized and multi-byte arguments are structurally limited and explicitly marked, and
 * credentials never ride the event log.
 */
import { describe, expect, it } from 'vitest';
import { toolArgumentsWire } from '../services/agui-events.js';

describe('standard tool argument document', () => {
  it('keeps small arguments parseable and masks secret-looking keys at every depth', () => {
    const wire = toolArgumentsWire({ q: 'wifi', nested: { password: 'hunter2', apiKey: 'sk-abcdefghijklmnop', ok: 1 } });
    expect(wire.truncated).toBe(false);
    expect(JSON.parse(wire.text)).toEqual({ q: 'wifi', nested: { password: '[redacted]', apiKey: '[redacted]', ok: 1 } });
    expect(wire.text).not.toContain('hunter2');
  });

  it('limits a long multi-byte value without cutting JSON in half', () => {
    const wire = toolArgumentsWire({ q: '中文'.repeat(3000), note: 'kept if it fits' });
    expect(wire.truncated).toBe(true);
    expect(() => JSON.parse(wire.text)).not.toThrow();
    const parsed = JSON.parse(wire.text) as { junoTruncated?: boolean; originalBytes?: number };
    expect(parsed.junoTruncated).toBe(true);
    expect(parsed.originalBytes).toBeGreaterThan(4000);
  });

  it('keeps whole top-level entries that fit and never leaks a secret in the marker', () => {
    const wire = toolArgumentsWire({ text: 'x'.repeat(5000), token: 'sk-live_secret_value', keep: 'yes' });
    expect(wire.truncated).toBe(true);
    expect(() => JSON.parse(wire.text)).not.toThrow();
    expect(wire.text).not.toContain('sk-live_secret_value');
  });
});
