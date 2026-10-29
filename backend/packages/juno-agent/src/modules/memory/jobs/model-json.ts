/** Reading structured answers out of model text. */

/** The first top-level JSON object in `text` (models wrap it in prose or code fences), or undefined. */
export function jsonObjectIn(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
