/** `POST /v1/screens/self/computer/copy`: `computer_copy` between the agent's sandbox and the owner's Mac. */
import type { Hono } from 'hono';
import { z } from 'zod';
import { copyBetweenComputers } from '../modules/computers/copy.js';
import type { ComputerdDeps } from './deps.js';
import { handle, requireAgent } from './http.js';

const side = z.enum(['sandbox', 'mac']);
const copySchema = z.object({ from: side, to: side, path: z.string().min(1), toPath: z.string().min(1) });

export function registerCopyRoutes(app: Hono, deps: ComputerdDeps): void {
  app.post('/v1/screens/self/computer/copy', (c) =>
    handle(c, async (signal) => {
      const agent = requireAgent(c);
      const request = copySchema.parse(await c.req.json().catch(() => undefined));
      const { binding } = await deps.lifecycle.requireAgentControl(agent, signal);
      return c.json(await copyBetweenComputers({ provider: deps.provider, binding, ...(deps.mac ? { mac: deps.mac } : {}) }, agent, request, signal));
    }),
  );
}
