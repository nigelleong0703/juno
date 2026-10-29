import { describe, expect, it } from 'vitest';
import { UsageError, resolveServeOptions } from '../cli-options.js';

const ENV = { JUNO_BASE_URL: 'https://juno.example.com', JUNO_TOKEN: 'tok-env' };

describe('juno serve options', () => {
  it('reads the server and token from the environment, without flags', () => {
    expect(resolveServeOptions([], ENV)).toEqual({
      baseUrl: 'https://juno.example.com',
      token: 'tok-env',
      tokenFromFlag: false,
    });
  });

  it('lets flags override the environment and marks a token given by flag', () => {
    expect(resolveServeOptions(['--base-url', 'http://127.0.0.1:9', '--token', 'tok-flag'], ENV)).toEqual({
      baseUrl: 'http://127.0.0.1:9',
      token: 'tok-flag',
      tokenFromFlag: true,
    });
  });

  it('takes the base URL from the environment when only the token is a flag', () => {
    expect(resolveServeOptions(['--token', 'tok-flag'], ENV)).toMatchObject({
      baseUrl: 'https://juno.example.com',
      token: 'tok-flag',
      tokenFromFlag: true,
    });
  });

  it('refuses a missing token, naming the variable to set', () => {
    expect(() => resolveServeOptions([], { JUNO_BASE_URL: ENV.JUNO_BASE_URL, JUNO_TOKEN: '' })).toThrow(UsageError);
    expect(() => resolveServeOptions([], { JUNO_BASE_URL: ENV.JUNO_BASE_URL, JUNO_TOKEN: '' })).toThrow(/JUNO_TOKEN/);
  });

  it('refuses a missing server, a flag without a value, and a base URL that is not absolute', () => {
    expect(() => resolveServeOptions([], { JUNO_TOKEN: 'tok' })).toThrow(/JUNO_BASE_URL/);
    expect(() => resolveServeOptions(['--token'], ENV)).toThrow(/--token needs a value/);
    expect(() => resolveServeOptions(['--base-url', ''], ENV)).toThrow(/--base-url needs a value/);
    expect(() => resolveServeOptions(['--base-url', 'notaurl'], ENV)).toThrow(UsageError);
  });
});
