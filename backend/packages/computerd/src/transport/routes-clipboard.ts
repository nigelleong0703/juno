/**
 * `POST /v1/screens/self/clipboard` and `GET /v1/screens/self/clipboard`: the computer clipboard side channel (M-CLIP).
 * Text keeps the VNC path; an image or a file travels here as base64 JSON. Both need the user to hold the screen, the same
 * rule as the writable stream, and every payload is capped at the app upload limit (decoded bytes).
 */
import type { Context, Hono } from 'hono';
import { ComputerdError, type ClipboardCopyResult, type ClipboardPaste } from '@agent-desktop/sandbox-adapters';
import { MAX_UPLOAD_BYTES, screenClipboardPasteSchema, type ScreenClipboardPaste } from '@agent-desktop/public-contracts';
import type { ComputerdDeps } from './deps.js';
import { handle, requireAgent } from './http.js';

/** Base64 is 4 characters per 3 bytes; the JSON around the files adds a little. */
const MAX_BODY_BYTES = Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024;

type Decoded = { ok: true; input: ClipboardPaste } | { ok: false; status: 400 | 413; code: string; message: string };

const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode one base64 payload; a non-canonical string is refused rather than silently repaired. */
function bytesOf(value: string): Uint8Array | null {
  if (!CANONICAL_BASE64.test(value) || value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

function decodePaste(body: ScreenClipboardPaste): Decoded {
  if (body.kind === 'image') {
    const bytes = bytesOf(body.contentBase64);
    if (bytes === null) return { ok: false, status: 400, code: 'invalid_clipboard', message: 'the image is not valid base64' };
    if (bytes.byteLength > MAX_UPLOAD_BYTES) return tooLarge(bytes.byteLength);
    return { ok: true, input: { kind: 'image', mimeType: body.mimeType, bytes } };
  }
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  let total = 0;
  for (const file of body.files) {
    const bytes = bytesOf(file.contentBase64);
    if (bytes === null) return { ok: false, status: 400, code: 'invalid_clipboard', message: `${file.name} is not valid base64` };
    total += bytes.byteLength;
    if (total > MAX_UPLOAD_BYTES) return tooLarge(total);
    files.push({ name: file.name, bytes });
  }
  return { ok: true, input: { kind: 'files', files } };
}

function tooLarge(sizeBytes: number): Decoded {
  return { ok: false, status: 413, code: 'too_large', message: `the clipboard item is ${sizeBytes} bytes; the limit is ${MAX_UPLOAD_BYTES}` };
}

function notInControl(c: Context) {
  return c.json({ code: 'NOT_IN_CONTROL', message: 'take over the screen first' }, 409);
}

function copyBody(c: Context, copied: ClipboardCopyResult) {
  switch (copied.kind) {
    case 'tooLarge':
      return c.json({ code: 'too_large', message: `the computer's clipboard item is ${copied.sizeBytes} bytes; the limit is ${MAX_UPLOAD_BYTES}` }, 413);
    case 'empty':
      return c.json({ kind: 'empty' });
    case 'text':
      return c.json({ kind: 'text', text: copied.text });
    case 'image':
      return c.json({ kind: 'image', mimeType: 'image/png', contentBase64: Buffer.from(copied.bytes).toString('base64') });
    case 'file':
      return c.json({ kind: 'file', name: copied.name, sizeBytes: copied.bytes.byteLength, contentBase64: Buffer.from(copied.bytes).toString('base64') });
  }
}

export function registerClipboardRoutes(app: Hono, deps: ComputerdDeps): void {
  app.post('/v1/screens/self/clipboard', (c) =>
    handle(c, async (signal) => {
      const agent = requireAgent(c);
      if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES) return c.json({ code: 'too_large', message: 'the clipboard item is larger than the limit' }, 413);
      const parsed = screenClipboardPasteSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!parsed.success) return c.json({ code: 'invalid_clipboard', message: 'the clipboard body does not match the contract' }, 400);
      const decoded = decodePaste(parsed.data);
      if (!decoded.ok) return c.json({ code: decoded.code, message: decoded.message }, decoded.status);
      const { binding, screen } = await deps.lifecycle.existingScreen(agent);
      if ((await deps.lifecycle.control.get({ kind: 'screen', screenId: screen.id }, agent)).holder !== 'user') return notInControl(c);
      const result = await deps.provider.act(binding, agent, screen.displayNo, { kind: 'clipboardPaste', input: decoded.input }, signal);
      if (!result.clipboardPaste) throw new ComputerdError('failed', 'provider returned no clipboard result');
      return c.json(result.clipboardPaste);
    }),
  );

  app.get('/v1/screens/self/clipboard', (c) =>
    handle(c, async (signal) => {
      const agent = requireAgent(c);
      const { binding, screen } = await deps.lifecycle.existingScreen(agent);
      if ((await deps.lifecycle.control.get({ kind: 'screen', screenId: screen.id }, agent)).holder !== 'user') return notInControl(c);
      const result = await deps.provider.act(binding, agent, screen.displayNo, { kind: 'clipboardCopy', maxBytes: MAX_UPLOAD_BYTES }, signal);
      if (!result.clipboardCopy) throw new ComputerdError('failed', 'provider returned no clipboard result');
      return copyBody(c, result.clipboardCopy);
    }),
  );
}
