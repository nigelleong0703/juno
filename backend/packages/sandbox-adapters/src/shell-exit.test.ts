/**
 * `shell.run` must return a non-zero exit code as data, not fail the request. Some runtimes
 * report a non-zero exit by THROWING a value with the command-exit shape (E2B's
 * `CommandExitError`), but `instanceof` is unreliable across module instances, so the shell
 * path detects the SHAPE. A real transport failure has no exit fields and must still propagate.
 */
import { describe, expect, it } from 'vitest';
import type { SandboxRuntime } from './runtime.js';
import { createScreenFile } from './screen-file.js';

function runtimeThat(behaviour: 'ok' | 'exit1' | 'throw'): SandboxRuntime {
  return {
    run: async () => {
      if (behaviour === 'ok') return { exitCode: 0, stdout: 'fine', stderr: '' };
      if (behaviour === 'exit1') {
        // A plain Error with the exit fields, i.e. NOT any imported class instance.
        throw Object.assign(new Error('exit 7'), { exitCode: 7, stdout: 'partial', stderr: 'expected' });
      }
      throw new Error('connection reset');
    },
    readText: async () => '',
    readBytes: async () => new Uint8Array(),
    writeText: async () => undefined,
    writeBytes: async () => undefined,
  };
}

describe('shell exit-code semantics', () => {
  it('returns a zero-exit command unchanged', async () => {
    const result = await createScreenFile().shell(runtimeThat('ok'), 1, { command: 'true', timeoutMs: 1000 });
    expect(result).toEqual({ exitCode: 0, stdout: 'fine', stderr: '' });
  });

  it('turns a shaped non-zero exit into a result with the real code and streams', async () => {
    const result = await createScreenFile().shell(runtimeThat('exit1'), 1, { command: 'false', timeoutMs: 1000 });
    expect(result).toEqual({ exitCode: 7, stdout: 'partial', stderr: 'expected' });
  });

  it('still surfaces a genuine transport failure', async () => {
    await expect(createScreenFile().shell(runtimeThat('throw'), 1, { command: 'x', timeoutMs: 1000 })).rejects.toThrow(
      /connection reset/,
    );
  });
});
