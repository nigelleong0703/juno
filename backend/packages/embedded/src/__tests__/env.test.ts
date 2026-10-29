import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { applyEnv, buildEmbeddedEnv, generateSecrets, pickFreePorts, RESERVED_PORTS } from '../env.js';

const input = (inherited: NodeJS.ProcessEnv, caller: Record<string, string> = {}) => ({
  inherited,
  caller,
  databaseUrl: 'postgres://postgres:postgres@127.0.0.1:50001/scratch',
  apiPort: 50002,
  agentdPort: 50003,
  dataDir: '/tmp/juno-test-data',
  secrets: generateSecrets(),
});

describe('embedded env', () => {
  it('sets the runtime values itself and points the database at the scratch one', () => {
    const env = buildEmbeddedEnv(input({ PATH: '/bin' }));
    expect(env).toMatchObject({
      PATH: '/bin',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:50001/scratch',
      API_PORT: '50002',
      AGENTD_PORT: '50003',
      AGENTD_URL: 'http://127.0.0.1:50003',
      BETTER_AUTH_URL: 'http://127.0.0.1:50002',
      AUTH_MODE: 'account',
      BLOB_DIR: join('/tmp/juno-test-data', 'blobs'),
    });
    expect(env['SECRETS_KEY']).toHaveLength(44);
    expect(env['BETTER_AUTH_SECRET']?.length).toBeGreaterThanOrEqual(32);
  });

  it('has no computer and no hosted embeddings unless the caller asks, whatever the shell says', () => {
    const env = buildEmbeddedEnv(input({ COMPUTERD_URL: 'http://127.0.0.1:8791', COMPUTER_PROVIDER: 'e2b', EMBEDDING_BASE_URL: 'https://embed.example' }));
    expect(env['COMPUTERD_URL']).toBeUndefined();
    expect(env['COMPUTER_PROVIDER']).toBeUndefined();
    expect(env['EMBEDDING_BASE_URL']).toBe('');
  });

  it('keeps the model settings inherited and the caller settings on top', () => {
    const env = buildEmbeddedEnv(input({ MODEL_ID: 'inherited-model' }, { MODEL_PROVIDER: 'scripted', SCRIPTED_MODEL_FILE: '/tmp/s.json', MODEL_ID: 'caller-model' }));
    expect(env).toMatchObject({ MODEL_PROVIDER: 'scripted', SCRIPTED_MODEL_FILE: '/tmp/s.json', MODEL_ID: 'caller-model' });
  });

  it('opts in to a computer only through env', () => {
    const env = buildEmbeddedEnv(input({}, { COMPUTERD_URL: 'http://127.0.0.1:9100', COMPUTERD_TOKEN: 'caller-token' }));
    expect(env).toMatchObject({ COMPUTERD_URL: 'http://127.0.0.1:9100', COMPUTERD_TOKEN: 'caller-token' });
  });

  it('refuses a caller value for a key the runtime owns', () => {
    expect(() => buildEmbeddedEnv(input({}, { DATABASE_URL: 'postgres://live' }))).toThrow(/DATABASE_URL is set by the embedded runtime/);
    expect(() => buildEmbeddedEnv(input({}, { API_PORT: '8787' }))).toThrow(/API_PORT/);
  });

  it('sets the process environment and restores it exactly', () => {
    process.env['EMBEDDED_TEST_KEEP'] = 'before';
    process.env['COMPUTERD_URL'] = 'http://from-shell';
    const restore = applyEnv({ EMBEDDED_TEST_KEEP: 'during', API_PORT: '50002' });
    expect(process.env['EMBEDDED_TEST_KEEP']).toBe('during');
    expect(process.env['API_PORT']).toBe('50002');
    expect(process.env['COMPUTERD_URL']).toBeUndefined();
    restore();
    expect(process.env['EMBEDDED_TEST_KEEP']).toBe('before');
    expect(process.env['API_PORT']).toBeUndefined();
    expect(process.env['COMPUTERD_URL']).toBe('http://from-shell');
    delete process.env['EMBEDDED_TEST_KEEP'];
    delete process.env['COMPUTERD_URL'];
  });
});

describe('embedded ports', () => {
  it('picks distinct free ports that are not reserved', async () => {
    const ports = await pickFreePorts(3);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) expect(RESERVED_PORTS).not.toContain(port);
    // The picked ports are free: a listener can take one of them now.
    const server = createServer();
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(ports[0], '127.0.0.1', () => done());
    });
    await new Promise<void>((done) => server.close(() => done()));
  });

});
