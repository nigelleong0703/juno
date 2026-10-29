/** Parse the one-line-per-field sample from `free`/`nproc`/`loadavg`/`df`. */
import type { SandboxRuntime } from './runtime.js';
import type { ComputerMetrics } from './types.js';

export const METRICS_COMMAND =
  `free -m | awk 'NR==2{print $3" "$2}'; nproc; awk '{print $1}' /proc/loadavg; df -m / | awk 'NR==2{print $3" "$2}'`;

export function parseMetrics(stdout: string): ComputerMetrics {
  const lines = stdout.trim().split('\n');
  const [memUsed, memTotal] = numbers(lines[0]);
  const vcpu = numbers(lines[1])[0] ?? 1;
  const load = numbers(lines[2])[0] ?? 0;
  const [diskUsed, diskTotal] = numbers(lines[3]);
  return {
    memUsedMb: memUsed ?? 0,
    memTotalMb: memTotal ?? 0,
    vcpu,
    cpuPercent: Math.min(100, Math.round((load / vcpu) * 100)),
    diskUsedGb: Math.round(((diskUsed ?? 0) / 1024) * 10) / 10,
    diskTotalGb: Math.round(((diskTotal ?? 0) / 1024) * 10) / 10,
  };
}

/**
 * Read one live resource sample through the narrow runtime. Passive by contract: a non-zero
 * exit or a transport failure yields null (no live sample), never a thrown error.
 */
export async function readMetrics(runtime: SandboxRuntime): Promise<ComputerMetrics | null> {
  try {
    const result = await runtime.run(METRICS_COMMAND, { timeoutMs: 15_000 });
    if (result.exitCode !== 0) return null;
    return parseMetrics(result.stdout);
  } catch {
    return null;
  }
}

function numbers(line: string | undefined): number[] {
  return (line ?? '').split(/\s+/).map(Number).filter(Number.isFinite);
}
