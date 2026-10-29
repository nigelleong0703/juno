// Label quoting for the social context: stored names and titles are directory
// data, never instructions. Quoting and bounding keep them readable as values.

// Stored labels are untrusted data: cap how much of one ever reaches the prompt.
const MAX_LABEL = 120;

// Quote stored labels so they read as data values, never as instructions.
export function quoteLabel(value: string | undefined): string {
  if (value === undefined) return '"(unknown)"';
  const short = value.length > MAX_LABEL ? value.slice(0, MAX_LABEL) + '\u2026' : value;
  return JSON.stringify(short);
}

/** A name with its @handle. A handle that is only the agent's id is not a name anyone uses, so it is left out. */
export function whoLine(name: string | undefined, handle: string | undefined, id?: string): string {
  if (handle === undefined || handle === id) return quoteLabel(name);
  return quoteLabel(name) + ' (' + quoteLabel('@' + handle) + ')';
}

export function quoteId(id: string): string {
  return "'" + id + "'";
}

// The agent-creation fallback title is not a configured role: it must never render as
// an identity or a specialty, or it reads back to the model as a name.
const DEFAULT_ROLE = 'New agent';

export function meaningfulRole(title: string | undefined): string | undefined {
  if (title === undefined) return undefined;
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed === DEFAULT_ROLE) return undefined;
  return trimmed;
}
