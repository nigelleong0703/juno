/**
 * computerd's system-package endpoint (BACKEND §7.9). An agent's Linux user has no sudo, so apt-get runs here, as
 * root. The agent runtime has already put the call through the user's approval (`computer.install_packages` always
 * asks); computerd still only accepts valid package names and an agent whose screen is not under user control.
 */
import type { Hono } from 'hono';
import { installPackages } from '@agent-desktop/sandbox-adapters';
import { handle, requireAgent } from './http.js';
import type { ComputerdDeps } from './deps.js';
import { installPackagesSchema } from './schema.js';

export function registerPackageRoutes(app: Hono, deps: ComputerdDeps): void {
  app.post('/v1/screens/self/install-packages', (c) =>
    handle(c, async (signal) => {
      const agent = requireAgent(c);
      const input = installPackagesSchema.parse(await c.req.json().catch(() => undefined));
      const { binding } = await deps.lifecycle.requireAgentControl(agent, signal);
      const output = await deps.provider.withRuntime(binding, signal, (runtime) => installPackages(runtime, input.packages), { user: 'root' });
      return Response.json({ output });
    }),
  );
}
