import { describe, expect, it } from 'vitest';
import { softenUiDocs } from '../http/ui-docs.js';

describe('softenUiDocs', () => {
  it('keeps a valid doc and replaces an undecodable one by its text fallback, wherever it is nested', () => {
    const valid = { version: 1, blocks: [{ type: 'text', text: 'hi' }], text: 'hi' };
    const future = { version: 1, title: 'Chart', blocks: [{ type: 'chart' }], text: 'Chart\n\nsales up' };
    const softened = softenUiDocs({ items: [{ type: 'agent_message', ui: valid }, { type: 'request', payload: { kind: 'question', ui: future } }] }) as {
      items: { ui?: unknown; payload?: { ui: unknown } }[];
    };
    expect(softened.items[0]?.ui).toEqual(valid);
    expect(softened.items[1]?.payload?.ui).toEqual({ version: 1, title: 'Chart', blocks: [{ type: 'text', text: 'Chart\n\nsales up' }], text: 'Chart\n\nsales up' });
  });
});
