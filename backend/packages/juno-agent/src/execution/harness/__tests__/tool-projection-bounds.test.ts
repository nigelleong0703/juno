// A result no tool bounded is cut once, before it enters the history: head and tail kept, middle dropped.
import { describe, expect, it } from 'vitest';
import { projectResult, RESULT_TEXT_BUDGET } from '../services/tool-projection.js';

const texts = (content: Array<{ type: string; text?: string }>) => content.filter(block => block.type === 'text').map(block => block.text ?? '');

describe('tool result budget', () => {
  it('cuts on UTF-8 bytes without splitting a character', () => {
    const body = '中'.repeat(RESULT_TEXT_BUDGET);
    const out = texts(projectResult({ content: [{ type: 'text', text: body }] }).content)[0] ?? '';
    expect(out).not.toContain('\uFFFD');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(RESULT_TEXT_BUDGET + 200);
  });
});
