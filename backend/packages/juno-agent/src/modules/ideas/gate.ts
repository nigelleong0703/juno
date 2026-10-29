/**
 * The capability gate for proactive ideas (BACKEND §5.10). An idea is only worth showing if the agent it names can do it:
 * the model declares the tool names the idea needs (`requires`), and an idea is kept only when every one of them is a tool
 * the agent really has now, allowed by its permission tiers and, for computer tools, a computer that exists.
 */
import type { PermissionTiers } from '@agent-desktop/public-contracts';

export interface AgentCapabilities {
  /** Model-visible tool names of the agent right now, connectors and MCP tools included. */
  tools: ReadonlySet<string>;
  /** The subset of `tools` that come from connectors (MCP); only those are checked against the send and purchase tiers by name. */
  mcpTools?: ReadonlySet<string>;
  tiers?: PermissionTiers;
  /** Whether the user has a computer to run computer tools on. */
  computer: boolean;
}

/** Tools that act on the user's computer; without one they cannot run even when the deployment registers them. */
const COMPUTER_TOOL = /^(computer\.|browser\.|shell\.|files\.)|^(computer_environment|send_file|artifact_publish|space_publish|request_takeover|request_secure_input)$/;
const SENDS = /(^|[._-])(send|reply|post|email|mail|message|dm)([._-]|$)/i;
const PURCHASES = /(^|[._-])(buy|purchase|order|checkout|pay|payment)([._-]|$)/i;

/** Why `tool` cannot be used under these capabilities, or undefined when it can. */
function unavailableReason(tool: string, caps: AgentCapabilities): string | undefined {
  if (!caps.tools.has(tool)) return 'the agent has no tool ' + tool;
  if (!caps.computer && COMPUTER_TOOL.test(tool)) return tool + ' needs a computer and there is none';
  if (caps.tiers?.send === 'never' && (tool === 'send_message' || (caps.mcpTools?.has(tool) === true && SENDS.test(tool)))) return tool + ' sends to people and the agent may never send';
  if (caps.tiers?.purchase === 'never' && caps.mcpTools?.has(tool) === true && PURCHASES.test(tool)) return tool + ' buys things and the agent may never purchase';
  return undefined;
}

/** What stops the agent from doing an idea that needs `requires`; empty means it can. */
export function missingCapabilities(requires: readonly string[], caps: AgentCapabilities): string[] {
  if (caps.tiers?.reachOut === 'off') return ['the agent may not reach out on its own (reachOut is off)'];
  return requires.flatMap((tool) => unavailableReason(tool, caps) ?? []);
}
