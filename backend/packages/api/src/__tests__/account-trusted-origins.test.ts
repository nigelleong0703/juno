import { describe, expect, it } from 'vitest';
import {
  buildAccountAuthOptions,
  parseExtraTrustedOrigins,
  resolveAuthMode,
} from '../account-auth.js';

const SECRET = 'test-secret-that-is-long-enough-32-chars';
const BASE = 'http://127.0.0.1:8787';
const DB = 'postgres://postgres:postgres@127.0.0.1:54329/agents';

describe('extra trusted origins', () => {
  it('parses only exact valid http(s) origins', () => {
    expect(parseExtraTrustedOrigins(undefined)).toEqual([]);
    expect(parseExtraTrustedOrigins('')).toEqual([]);
    expect(
      parseExtraTrustedOrigins('https://app.example.com, http://localhost:5199/'),
    ).toEqual(['https://app.example.com', 'http://localhost:5199']);
  });

  it('rejects wildcards, null, file and non-url values', () => {
    expect(
      parseExtraTrustedOrigins('*, null, file:///x, notaurl, https://*.example.com'),
    ).toEqual([]);
    const opts = buildAccountAuthOptions({
      secret: SECRET,
      baseURL: BASE,
      trustedOrigins: ['*', 'null', 'file:///x'],
    });
    expect(opts.trustedOrigins).not.toContain('*');
    expect(opts.trustedOrigins).not.toContain('null');
    expect(opts.trustedOrigins.join(' ')).not.toContain('file:');
  });

  it('flows from env through resolveAuthMode into BetterAuth options', () => {
    const mode = resolveAuthMode(
      {
        AUTH_MODE: 'account',
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: BASE,
        AUTH_TRUSTED_ORIGINS: 'https://app.example.com',
      },
      DB,
    );
    if (mode.mode !== 'account') throw new Error('expected account mode');
    expect(mode.trustedOrigins).toEqual(['https://app.example.com']);
    const opts = buildAccountAuthOptions({
      secret: SECRET,
      baseURL: BASE,
      trustedOrigins: mode.trustedOrigins,
    });
    expect(opts.trustedOrigins).toContain('https://app.example.com');
    expect(opts.trustedOrigins).toContain('http://localhost:5199');
  });
});
