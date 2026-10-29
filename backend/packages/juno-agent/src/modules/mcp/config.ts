// Normalized MCP server config derived from the public create input: either an http URL or a
// sandbox stdio command, and nothing else, so no unpublished transport can be smuggled in.
export type McpServerConfig =
  | { transport: 'http'; url: string; /** The owner's own API key as a request header (a catalog `userApiKey` connector). */ headers?: Record<string, string> }
  | { transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> };

export type McpConfigResult = { ok: true; config: McpServerConfig } | { ok: false; reason: string };

export interface McpConfigInput {
  transport?: 'http' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export function parseMcpServerConfig(input: McpConfigInput): McpConfigResult {
  const transport = input.transport ?? (input.url !== undefined ? 'http' : input.command !== undefined ? 'stdio' : undefined);
  if (transport === 'http') {
    if (input.url === undefined || input.url === '') return { ok: false, reason: 'an http MCP server requires a url' };
    return { ok: true, config: { transport: 'http', url: input.url } };
  }
  if (transport === 'stdio') {
    if (input.command === undefined || input.command === '') return { ok: false, reason: 'a stdio MCP server requires a command' };
    return {
      ok: true,
      config: {
        transport: 'stdio',
        command: input.command,
        args: input.args ?? [],
        ...(input.env === undefined ? {} : { env: input.env }),
      },
    };
  }
  return { ok: false, reason: 'an MCP server requires either a url (http) or a command (stdio)' };
}
