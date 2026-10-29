import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { selectProvider } from '../provider.js';

const BASE_URL = 'http://127.0.0.1:10100/v1';
let tempDir: string | undefined;
let scriptCount = 0;

async function scriptedFile(scripts: Record<string, unknown>): Promise<string> {
  tempDir ??= await mkdtemp(join(tmpdir(), 'runner-config-'));
  scriptCount += 1;
  const file = join(tempDir, `script-${scriptCount}.json`);
  await writeFile(file, JSON.stringify(scripts), 'utf8');
  return file;
}

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe('selectProvider', () => {
  it('leaves the platform default unconfigured when MODEL_BASE_URL is missing', () => {
    const env = { MODEL_ID: 'configured-model' };
    expect(selectProvider(env, loadConfig(env))).toBeUndefined();
  });

  it('leaves the platform default unconfigured when MODEL_ID is not explicitly set, even though loadConfig defaults it', () => {
    const env = { MODEL_BASE_URL: BASE_URL };
    const config = loadConfig(env);
    expect(config.MODEL_ID).toBe('gpt-6-astra');
    // The platform default is optional: an incomplete MODEL_* set means no platform default, not a crash.
    expect(selectProvider(env, config)).toBeUndefined();
  });

  it('leaves the platform default unconfigured when both settings are missing', () => {
    const log = vi.fn();
    expect(selectProvider({}, loadConfig({}), log)).toBeUndefined();
    expect(log).toHaveBeenCalledWith({}, 'Model provider: platform default not configured');
  });

  it('rejects an unknown MODEL_PROVIDER', () => {
    expect(() => selectProvider({ MODEL_PROVIDER: 'unknown' }, loadConfig({}))).toThrow(
      /Unknown MODEL_PROVIDER=unknown/,
    );
  });

  it('requires SCRIPTED_MODEL_FILE in scripted mode', () => {
    expect(() => selectProvider({ MODEL_PROVIDER: 'scripted' }, loadConfig({}))).toThrow(
      /SCRIPTED_MODEL_FILE/,
    );
  });

  it('scripted mode returns a provider and reports the file it selected', async () => {
    const file = await scriptedFile({ 'agent-1:conv-1': [{ text: 'scripted reply' }] });
    const log = vi.fn();
    const env = { MODEL_PROVIDER: 'scripted', SCRIPTED_MODEL_FILE: file };

    const provider = selectProvider(env, loadConfig(env), log)!;

    expect(typeof provider.call).toBe('function');
    expect(log).toHaveBeenCalledWith({ file }, 'Model provider: scripted');
  });

  it('scripted mode reads turns from the file and ignores real-model env', async () => {
    const file = await scriptedFile({ 'agent-1:conv-1': [{ text: 'scripted reply' }] });
    const env = {
      MODEL_PROVIDER: 'scripted',
      SCRIPTED_MODEL_FILE: file,
      MODEL_BASE_URL: BASE_URL,
      MODEL_ID: 'should-be-ignored',
    };

    const provider = selectProvider(env, loadConfig(env))!;
    const turn = await provider.call({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      sessionKey: 'agent-1:conv-1',
    });

    expect(turn.text).toBe('scripted reply');
  });

  it('returns the openai-compatible provider when the env is complete', () => {
    const log = vi.fn();
    const env = { MODEL_BASE_URL: BASE_URL, MODEL_ID: 'env-model' };

    const provider = selectProvider(env, loadConfig(env), log)!;

    expect(typeof provider.call).toBe('function');
    expect(log).toHaveBeenCalledWith(
      { baseUrl: BASE_URL, model: 'env-model', supportsImages: false },
      'Model provider: openai-compatible',
    );
  });

  it('reports images enabled only when MODEL_SUPPORTS_IMAGES=true', () => {
    const log = vi.fn();
    const env = { MODEL_BASE_URL: BASE_URL, MODEL_ID: 'env-model', MODEL_SUPPORTS_IMAGES: 'true' };

    selectProvider(env, loadConfig(env), log);

    expect(log).toHaveBeenCalledWith(
      { baseUrl: BASE_URL, model: 'env-model', supportsImages: true },
      'Model provider: openai-compatible',
    );
  });

  it('accepts an explicit false and fails loudly on any other MODEL_SUPPORTS_IMAGES value', () => {
    const env = { MODEL_BASE_URL: BASE_URL, MODEL_ID: 'env-model', MODEL_SUPPORTS_IMAGES: 'false' };
    expect(() => selectProvider(env, loadConfig(env))).not.toThrow();
    expect(() => selectProvider(
      { MODEL_BASE_URL: BASE_URL, MODEL_ID: 'env-model', MODEL_SUPPORTS_IMAGES: 'yes' },
      loadConfig(env),
    )).toThrow(/MODEL_SUPPORTS_IMAGES=yes/);
  });

  it('the real provider attempts a model call instead of falling back to scripted text', async () => {
    const env = { MODEL_BASE_URL: 'http://127.0.0.1:1/v1', MODEL_ID: 'env-model' };
    const controller = new AbortController();
    controller.abort();

    const provider = selectProvider(env, loadConfig(env))!;

    await expect(
      provider.call({ messages: [], tools: [], signal: controller.signal }),
    ).rejects.toThrow();
  });
});
