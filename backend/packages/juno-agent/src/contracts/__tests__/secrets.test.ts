import { describe, expect, it } from 'vitest';
import { storedConfig } from '../../modules/mcp/connections.js';
import { decryptSecret, encryptSecret, readSecretsKey, requireSecretsKey, SecretsError } from '../secrets.js';

const key = Buffer.alloc(32, 3);
const otherKey = Buffer.alloc(32, 4);

describe('secrets at rest', () => {
  it('round-trips a value and never stores it in the clear', () => {
    const stored = encryptSecret('sk-live-123', key);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('sk-live-123');
    expect(decryptSecret(stored, key)).toBe('sk-live-123');
    expect(encryptSecret('sk-live-123', key)).not.toBe(stored);
  });

  it('returns a legacy plaintext value as-is, without needing the key', () => {
    expect(decryptSecret('plain-token', undefined)).toBe('plain-token');
  });

  it('fails on a tampered value or the wrong key, without echoing the value', () => {
    const stored = encryptSecret('sk-live-123', key);
    const tampered = stored.slice(0, -2) + (stored.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered, key)).toThrow(SecretsError);
    expect(() => decryptSecret(stored, otherKey)).toThrow(SecretsError);
    expect(() => decryptSecret('enc:v1:AAAA', key)).toThrow(SecretsError);
  });

  it('refuses a missing or malformed key', () => {
    expect(() => requireSecretsKey({})).toThrow(/SECRETS_KEY is required/);
    expect(() => requireSecretsKey({ SECRETS_KEY: 'short' })).toThrow(/32 random bytes/);
    expect(() => requireSecretsKey({ SECRETS_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 random bytes/);
    expect(readSecretsKey({ SECRETS_KEY: key.toString('base64') }).equals(key)).toBe(true);
  });

  it('rebuilds a stdio MCP config with decrypted env and still accepts legacy plaintext env', () => {
    const previous = process.env['SECRETS_KEY'];
    process.env['SECRETS_KEY'] = key.toString('base64');
    try {
      const doc = {
        endpoint: 'mcp-server',
        transport: 'stdio',
        args: ['--flag'],
        env: { TOKEN: encryptSecret('sk-live-123', key), LEGACY: 'plain' },
      };
      expect(storedConfig(doc)).toEqual({
        transport: 'stdio',
        command: 'mcp-server',
        args: ['--flag'],
        env: { TOKEN: 'sk-live-123', LEGACY: 'plain' },
      });
      expect(storedConfig({ endpoint: 'mcp-server', transport: 'stdio' })).toEqual({ transport: 'stdio', command: 'mcp-server', args: [] });
    } finally {
      if (previous === undefined) delete process.env['SECRETS_KEY'];
      else process.env['SECRETS_KEY'] = previous;
    }
  });
});
