import { uiDocSchema } from '../contracts.js';

/**
 * Forward compatibility for Juno UI blocks (BACKEND 8.7.1): a doc this client cannot decode (a block
 * type it does not know yet) must still show its server-written `text`, never drop the card or fail
 * the whole item. So before a response or stream event is parsed, every `ui` doc that does not match
 * the schema is replaced by a one-text-block doc carrying `ui.text`.
 */
function isDocShaped(value: unknown): value is { version: unknown; blocks: unknown; text?: unknown; title?: unknown } {
  return typeof value === 'object' && value !== null && 'blocks' in value && 'version' in value;
}

function softenDoc(doc: { text?: unknown; title?: unknown }): unknown {
  const text = typeof doc.text === 'string' && doc.text.trim().length > 0 ? doc.text : 'This card needs a newer version of the app.';
  return {
    version: 1,
    ...(typeof doc.title === 'string' && doc.title.length > 0 && doc.title.length <= 80 ? { title: doc.title } : {}),
    blocks: [{ type: 'text', text: text.slice(0, 400) }],
    text,
  };
}

export function softenUiDocs(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(softenUiDocs);
  if (typeof data !== 'object' || data === null) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'ui' && isDocShaped(value)) out[key] = uiDocSchema.safeParse(value).success ? value : softenDoc(value);
    else out[key] = softenUiDocs(value);
  }
  return out;
}
