/** The argument boundary turns numbers written as text into numbers, whatever else the model sent, and still refuses real text. */
import { describe, expect, it } from 'vitest';
import type { Tool } from '../../../contracts/index.js';
import { createComputerClickTool } from '../../../modules/tools/tools/computerMouse.js';
import { checkedCall } from '../services/run-tool-check.js';
import type { RunInput, RunServices } from '../services/run-types.js';

const click: Tool = createComputerClickTool({});
const services = { toolRegistry: { get: (name: string) => (name === click.name ? click : undefined) } } as unknown as RunServices;
const input = { modelId: 'm' } as unknown as RunInput;

describe('checkedCall number coercion', () => {
  it('coerces "140.0" for x and y (the 2026-11-02 Ticketmaster call, with its stray sentence field)', () => {
    const out = checkedCall(services, input, 'run-1', { name: click.name, arguments: { sentence: 'pick CAT8 334', x: '140.0', y: '358.0' } });
    expect(out.invalid).toBeNull();
    expect(out.call.arguments).toMatchObject({ x: 140, y: 358 });
  });

  it('coerces plain numeric strings', () => {
    const out = checkedCall(services, input, 'run-1', { name: click.name, arguments: { x: '140', y: ' 358 ' } });
    expect(out.invalid).toBeNull();
    expect(out.call.arguments).toMatchObject({ x: 140, y: 358 });
  });

  it('still refuses text that is not a number', () => {
    const out = checkedCall(services, input, 'run-1', { name: click.name, arguments: { x: 'left', y: '358' } });
    expect(out.invalid?.isError).toBe(true);
    expect(JSON.stringify(out.invalid?.content)).toContain('x: received a string of 4 characters');
  });
});
