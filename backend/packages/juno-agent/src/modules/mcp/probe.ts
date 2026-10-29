// What an MCP server at a URL asks of the person who adds it, found without any credential (BACKEND 10.18.3). The one probe behind the
// custom-server confirm step and the admin's "draft an app from a URL": reachability, how it lets people in (nothing, an OAuth sign-in with
// the client we would use, or a key), and, when it answers without a login, its tool list with a suggested read / change mark per tool.
// Nothing is stored here and nothing is called but `initialize`, metadata documents and `tools/list`.
import { configuredClientFor, discoverAuthorizationServer, McpOAuthError, probeMcpServer, type ClientSecretNames } from './oauth.js';
import { McpClient } from './client.js';
import { HttpMcpTransport } from './http-transport.js';
import { classifyTool } from './tool-access.js';

export type ProbedAuth = 'none' | 'oauth' | 'api_key';
export type ProbedClient = 'provided' | 'cimd' | 'dcr';

export interface ProbedTool {
  name: string;
  title: string;
  /** Our suggestion from the server's annotations; a tool with no usable hint is suggested as a change (an unmarked tool asks first). */
  suggested: 'read' | 'change';
  /** Why: the server marked it (`annotation`), or nothing did (`unmarked`). */
  basis: 'annotation' | 'unmarked';
}

export interface McpProbe {
  url: string;
  /** `none`: it answered without a login. `oauth`: it names an authorization server. `api_key`: it wants a credential but names no authorization server. */
  auth: ProbedAuth;
  oauth?: {
    issuer: string;
    scopes: string[];
    /** The client this deployment would sign in with: ours registered with the issuer (`provided`), a hosted client metadata document (`cimd`) or dynamic registration (`dcr`). */
    client: ProbedClient;
    /** False when the issuer takes none of them here (the sign-in cannot start): a client has to be registered by hand first. */
    usable: boolean;
  };
  /** Only for a server that answered without a login and listed its tools. */
  tools?: ProbedTool[];
  toolsTruncated?: boolean;
}

export interface ProbeOptions {
  fetchImpl: typeof fetch;
  /** The deployment's environment, to know which issuers have a registered client. */
  env?: Record<string, string | undefined>;
  /** Whether this deployment can host a client metadata document (a public https address). */
  cimd?: boolean;
  signal?: AbortSignal;
  /** Secret names a package gives for its own provided client (an admin draft of a known app); absent for a bare URL. */
  clientNames?: ClientSecretNames;
}

const TOOL_LIST_TIMEOUT_MS = 15_000;

/** Reads the open server's tools. A server that answers `initialize` but refuses `tools/list` without a login (Google's) has none to show. */
async function openTools(url: string, opts: ProbeOptions): Promise<Pick<McpProbe, 'tools' | 'toolsTruncated'>> {
  const client = new McpClient(() => new HttpMcpTransport({ url, fetchImpl: opts.fetchImpl }));
  const signal = opts.signal ?? AbortSignal.timeout(TOOL_LIST_TIMEOUT_MS);
  try {
    await client.connect({ signal });
    const found = await client.discoverTools({ signal });
    const tools = found.tools.map((tool): ProbedTool => {
      const hints = tool.annotations;
      const marked = typeof hints?.['readOnlyHint'] === 'boolean' || hints?.['destructiveHint'] === true;
      return {
        name: tool.name,
        title: tool.title ?? (typeof hints?.['title'] === 'string' ? hints['title'] : tool.name),
        suggested: classifyTool(tool) === 'read' ? 'read' : 'change',
        basis: marked ? 'annotation' : 'unmarked',
      };
    });
    return { tools, ...(found.truncated ? { toolsTruncated: true } : {}) };
  } catch {
    return {};
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Probes `url`. Throws `McpOAuthError` when the server cannot be reached (`MCP_UNREACHABLE`), the guard refuses the address (`MCP_URL_BLOCKED`) or
 * its OAuth metadata is wrong in a way we do not bend (`MCP_OAUTH_DISCOVERY`: a protected-resource `resource` that is not this URL, no S256, ...).
 */
export async function probeMcpEndpoint(url: string, opts: ProbeOptions): Promise<McpProbe> {
  const first = await probeMcpServer(url, opts.fetchImpl);
  if (first.open) return { url, auth: 'none', ...(await openTools(url, opts)) };
  let server;
  try {
    server = await discoverAuthorizationServer(url, first.resourceMetadataUrl, opts.fetchImpl);
  } catch (error) {
    // A server that names its metadata and gets it wrong is refused as it is; one that names no authorization server at all wants a credential we cannot sign in for.
    if (error instanceof McpOAuthError && error.code === 'MCP_OAUTH_DISCOVERY' && first.resourceMetadataUrl === undefined) return { url, auth: 'api_key' };
    throw error;
  }
  const configured = configuredClientFor(server.issuer, opts.env ?? {}, opts.clientNames) !== undefined;
  const client: ProbedClient = configured ? 'provided' : server.clientIdMetadataDocumentSupported === true && opts.cimd === true ? 'cimd' : server.registrationEndpoint !== undefined ? 'dcr' : 'provided';
  const scopes = first.challengeScope?.split(/\s+/).filter((scope) => scope !== '') ?? server.scopesSupported ?? [];
  return { url, auth: 'oauth', oauth: { issuer: server.issuer, scopes, client, usable: client !== 'provided' || configured } };
}
