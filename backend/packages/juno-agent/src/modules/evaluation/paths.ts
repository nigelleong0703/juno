import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the server keeps its evaluation reports (the weekly tool x model table, the failure attribution, the evalbank runs). It is the
 * server's own disk: not an owner's home (`/juno` lives in the sandbox) and not a sandbox mount (docker-driver mounts no host paths). The
 * agent's file tools refuse it on every target, the Mac included (tools/homeGuard.ts `refuseServerReports`). The default is shared by
 * scripts/evalbank.mjs, which keeps the same one-line default.
 */
export function evalReportsDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env['EVAL_REPORTS_DIR']?.trim();
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.juno-server', 'eval-reports');
}
