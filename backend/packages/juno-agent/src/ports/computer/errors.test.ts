import { describe, expect, it } from 'vitest';
import { isComputerError } from './errors.js';

/**
 * Stand-in for the host's provider-local error class: same wire shape
 * (`code` + canonical `httpStatus`) but a different class identity, so
 * an `instanceof`-only check would reject it.
 */
class ForeignProviderError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(message: string, code: string, httpStatus: number) {
    super(message);
    this.name = 'ComputerdError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function foreignError(code: string, httpStatus: number): Error {
  const error = new Error('foreign');
  error.name = 'ComputerdError';
  Object.assign(error, { code, httpStatus });
  return error;
}

describe('isComputerError', () => {
  it('accepts foreign errors with a valid code and canonical status', () => {
    expect(new ForeignProviderError('gone', 'no_screen', 404)).toSatisfy(isComputerError);
    expect(foreignError('unavailable', 503)).toSatisfy(isComputerError);
    expect(foreignError('aborted', 408)).toSatisfy(isComputerError);
  });

  it('rejects malformed code/status shapes', () => {
    expect(foreignError('no-such-code', 404)).toSatisfy((error) => !isComputerError(error));
    expect(new ForeignProviderError('gone', 'no_screen', 500)).toSatisfy(
      (error) => !isComputerError(error),
    );
    expect(foreignError('failed', 200)).toSatisfy((error) => !isComputerError(error));
    expect(new Error('plain')).toSatisfy((error) => !isComputerError(error));
  });
});
