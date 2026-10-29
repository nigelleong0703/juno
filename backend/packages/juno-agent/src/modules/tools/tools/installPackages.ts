/**
 * computer.install_packages — install system (apt) packages on the agent's computer.
 *
 * An agent's Linux user has no sudo (BACKEND §7.9), so this is the only way to add system software. The policy
 * always asks the user first (builtin.install-packages, never relaxed by a rule), and then computerd runs
 * apt-get as root. Language packages (pip --user, npm with the user prefix, uv) install into the agent's own home from a shell and need no tool.
 */
import { z } from 'zod';
import type { Tool, ToolContext, ToolResult } from '../../../contracts/index.js';
import { MAX_INSTALL_PACKAGES, PACKAGE_NAME } from '../../../ports/computer/index.js';
import { ComputerError } from '../computer/contract.js';
import { requireComputerClient, type ComputerClientProvider } from '../computer/client.js';
import { actionResult, computerFailure } from '../computer/shared.js';

const schema = z.object({
  packages: z.array(z.string().regex(PACKAGE_NAME)).min(1).max(MAX_INSTALL_PACKAGES),
  reason: z.string().trim().min(1).max(300),
});

export function createInstallPackagesTool(opts: { computer?: ComputerClientProvider }): Tool {
  return {
    name: 'computer.install_packages',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        packages: { type: 'array', items: { type: 'string' }, description: '' },
        reason: { type: 'string', description: '' },
      },
      required: ['packages', 'reason'],
      additionalProperties: false,
    },
    // An install changes the machine; never replay it after a crash.
    replay: 'never',
    sideEffect: true,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = schema.parse(args);
      try {
        const client = requireComputerClient(opts.computer);
        if (typeof client.installPackages !== 'function') {
          throw new ComputerError('unavailable', 'installing system packages is not available on this deployment');
        }
        const result = await client.installPackages(ctx.agentId, { packages: parsed.packages, reason: parsed.reason }, ctx.signal);
        return actionResult('Installed ' + parsed.packages.join(', ') + '\n' + result.output, { packages: parsed.packages });
      } catch (error) {
        return computerFailure(error, ctx.signal);
      }
    },
  };
}
