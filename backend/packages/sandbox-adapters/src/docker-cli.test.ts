/**
 * Process-handling tests for the docker CLI spawn: no daemon needed, the `bin` seam points at
 * resident binaries. The EPIPE case is the regression that matters: a process that exits
 * without reading stdin must resolve with its real exit code, never crash computerd.
 */
import { describe, expect, it } from 'vitest';
import { createDockerCli, isDockerDaemonDown } from './docker-cli.js';

describe('docker cli process handling', () => {
  it('runs a command and reports stdout with a zero exit', async () => {
    const result = await createDockerCli('echo').run(['hello']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
  });

  it('survives EPIPE when the process exits before reading stdin', async () => {
    const result = await createDockerCli('false').run(['anything'], { stdin: 'x'.repeat(1024 * 1024) });
    expect(result.exitCode).toBe(1);
  });

  it('fails a hung command as a timeout', async () => {
    await expect(createDockerCli('sleep').run(['30'], { timeoutMs: 300 })).rejects.toThrow(/timed out/);
  });

  it('reports a missing binary as unavailable, not a crash', async () => {
    await expect(createDockerCli('/nonexistent/docker-bin-xyz').run(['ps'])).rejects.toThrow(/not found on PATH/);
  });
});

describe('docker daemon classifier', () => {
  it('flags only the docker CLI own daemon and socket failures', () => {
    expect(isDockerDaemonDown('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')).toBe(true);
    expect(isDockerDaemonDown('error during connect: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.45/containers/x/json"')).toBe(true);
  });

  it('does not blame the daemon for a dead browser inside a healthy container', () => {
    expect(isDockerDaemonDown('{"ok": false, "error": "no CDP on 127.0.0.1:9223 (Connection refused)"}')).toBe(false);
    expect(isDockerDaemonDown('curl: (7) Failed to connect to 127.0.0.1 port 6080: Connection refused')).toBe(false);
  });
});
