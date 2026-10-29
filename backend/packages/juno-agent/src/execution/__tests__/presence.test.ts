import { afterEach, describe, expect, it } from 'vitest';
import { clientKind, resetPresence } from '../presence.js';

afterEach(() => resetPresence());

describe('presence line for the agent context', () => {
  it('only counts clients that name themselves', () => {
    expect(clientKind('ios')).toBe('ios');
    expect(clientKind('android')).toBe('android');
    expect(clientKind('curl')).toBeUndefined();
    expect(clientKind(undefined)).toBeUndefined();
  });
});
