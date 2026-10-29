// The parameters of a `WWW-Authenticate: Bearer ...` challenge an MCP server answers with (MCP authorization, RFC 9728 / RFC 6750): where its
// protected resource metadata is, which scope it wants, and why it refused (`invalid_token`, `insufficient_scope`).

export interface Challenge {
  /** RFC 9728 `resource_metadata`: the URL of the protected resource metadata document. */
  resourceMetadata?: string;
  /** The scope the server asks for (on a 401, to start the sign-in with; on a 403 `insufficient_scope`, to step up to). */
  scope?: string;
  error?: string;
}

/** Quoted or bare `key=value` parameters of a challenge; a missing or non-Bearer header is an empty challenge. */
export function parseChallenge(header: string | null): Challenge {
  if (header === null || !/^\s*bearer\b/i.test(header)) return {};
  const found: Record<string, string> = {};
  for (const match of header.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|([^\s,"]+))/g)) {
    const key = (match[1] ?? '').toLowerCase();
    if (!(key in found)) found[key] = match[2] ?? match[3] ?? '';
  }
  return {
    ...(found['resource_metadata'] === undefined ? {} : { resourceMetadata: found['resource_metadata'] }),
    ...(found['scope'] === undefined || found['scope'] === '' ? {} : { scope: found['scope'] }),
    ...(found['error'] === undefined ? {} : { error: found['error'] }),
  };
}

/** The scopes of two space-separated scope lists, each once, in order. */
export function mergeScopes(...lists: Array<string | readonly string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    const items = typeof list === 'string' ? list.split(/\s+/) : list ?? [];
    for (const scope of items) if (scope !== '' && !out.includes(scope)) out.push(scope);
  }
  return out;
}
