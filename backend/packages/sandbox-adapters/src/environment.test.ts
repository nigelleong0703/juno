/**
 * The bound computer environment: the remote probe parses (including a non-default base
 * path), partial reads fail instead of inventing directories, and neither provider consults
 * the local process.
 */
import { describe, expect, it } from 'vitest';
import {
  computerEnvironmentSchema,
  ENVIRONMENT_COMMAND,
  isEnvAbsolute,
  parseEnvironment,
  parseEnvironmentOutput,
  resolveEnvPath,
} from './environment.js';

const PROBE = [
  'os=Linux 6.8.0 x86_64',
  'platform=Linux',
  'user=sandbox-user',
  'home=/home/sandbox-user',
  'cwd=/custom/base',
].join('\n') + '\n';

describe('computer environment', () => {
  it('parses the remote probe, honoring a non-default base path', () => {
    expect(parseEnvironmentOutput(PROBE)).toEqual({
      os: 'Linux 6.8.0 x86_64',
      platform: 'linux',
      user: 'sandbox-user',
      home: '/home/sandbox-user',
      workingDirectory: '/custom/base',
      pathStyle: 'posix',
      kind: 'sandbox',
    });
  });

  it('rejects partial probe output instead of inventing directories', () => {
    expect(() => parseEnvironmentOutput('os=Linux' + '\n' + 'platform=Linux' + '\n')).toThrow(/incomplete/);
    expect(() => parseEnvironmentOutput('garbage without fields')).toThrow(/incomplete/);
    expect(() => parseEnvironment({})).toThrow();
    expect(computerEnvironmentSchema.safeParse({ ...parseEnvironmentOutput(PROBE), workingDirectory: '' }).success).toBe(false);
  });

  it('probes the remote sandbox, never the local process', () => {
    expect(ENVIRONMENT_COMMAND).toContain('$PWD');
    expect(ENVIRONMENT_COMMAND).toContain('uname');
    expect(ENVIRONMENT_COMMAND).toContain('id -un');
    expect(ENVIRONMENT_COMMAND).not.toContain('localhost');
  });

  it('resolves relative paths against the binding directory and passes absolutes through', () => {
    const env = { workingDirectory: '/custom/base' };
    expect(resolveEnvPath(env, 'notes/a.md')).toBe('/custom/base/notes/a.md');
    expect(resolveEnvPath(env, './x')).toBe('/custom/base/x');
    expect(resolveEnvPath(env, '')).toBe('/custom/base');
    expect(resolveEnvPath(env, '/etc/hostname')).toBe('/etc/hostname');
    expect(isEnvAbsolute('/a')).toBe(true);
    expect(isEnvAbsolute('a')).toBe(false);
  });

});
