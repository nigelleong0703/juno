import { aguiInput } from '../../agui-input.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, lastModelImages, scriptModel, toolCall, waitForToolActivity, waitForTranscript, type Account } from '../harness/client';

// A real 1x1 PNG: the agent side recognizes images by their signature, not by the claimed mime.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHcMTUAAAAABJRU5ErkJggg==';
const b64 = (text: string): string => Buffer.from(text).toString('base64');

async function chat(account: Account): Promise<{ agentId: string; conversationId: string; sessionKey: string }> {
  const agent = await account.api('POST', '/v1/agents', { name: 'Reader' });
  expect(agent.status).toBe(201);
  const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
  expect(created.status).toBe(201);
  return { agentId: agent.body.id, conversationId: created.body.id, sessionKey: `${agent.body.id}:${created.body.id}` };
}

describe('attachments', () => {
  it('delivers an uploaded text file and image to the agent, pages long text, and keeps uploads private', async () => {
    const alice = await createAccount('attach-a');
    const bob = await createAccount('attach-b');

    // Upload: the reply is the Attachment to send; the file is also an ordinary library row of its owner.
    const long = 'HEAD-MARK ' + 'x'.repeat(40_000) + ' TAIL-MARK';
    const note = await alice.api('POST', '/v1/uploads', { name: 'notes.txt', mimeType: 'text/plain', contentBase64: b64('SECRET-MARK budget is 42') });
    const longText = await alice.api('POST', '/v1/uploads', { name: 'long.txt', mimeType: '', contentBase64: b64(long) });
    const png = await alice.api('POST', '/v1/uploads', { name: 'dot.png', mimeType: 'image/png', contentBase64: PNG_BASE64 });
    expect([note.status, longText.status, png.status]).toEqual([201, 201, 201]);
    expect(note.body).toMatchObject({ name: 'notes.txt', kind: 'file', mimeType: 'text/plain', sizeBytes: 24 });
    expect(longText.body).toMatchObject({ kind: 'file', mimeType: 'application/octet-stream' });
    expect(png.body).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    const stored = await alice.api('GET', `/v1/library/${note.body.id}`);
    expect(stored.body).toMatchObject({ source: 'upload', name: 'notes.txt' });

    // Limits: oversize and malformed uploads are refused, nothing is stored.
    const tooBig = await alice.api('POST', '/v1/uploads', { name: 'big.bin', mimeType: '', contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') });
    expect(tooBig.status).toBe(413);
    const notBase64 = await alice.api('POST', '/v1/uploads', { name: 'bad.txt', mimeType: '', contentBase64: 'not base64!' });
    expect(notBase64.status).toBe(400);
    // Another account cannot read the upload through the library.
    expect((await bob.api('GET', `/v1/library/${note.body.id}`)).status).toBe(404);
    expect((await bob.api('GET', `/v1/library/${note.body.id}/download`)).status).toBe(404);

    // The agent receives small text inline and the image block; the long file is only pointed at, and attachment_read still pages it.
    const { conversationId, sessionKey } = await chat(alice);
    const tooMany = await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'x', attachments: Array.from({ length: 6 }, () => note.body) }));
    expect(tooMany.status).toBe(400);
    scriptModel(sessionKey, [
      { toolCalls: [toolCall('read-1', 'attachment_read', { id: longText.body.id, offset: 32768 })] },
      { text: 'read it all' },
    ]);
    const sent = await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'look at these', attachments: [note.body, longText.body, png.body] }));
    expect(sent.status).toBe(202);
    expect(sent.body.item.attachments.map((a: { name: string }) => a.name)).toEqual(['notes.txt', 'long.txt', 'dot.png']);

    const transcript = await waitForTranscript(sessionKey, (messages) => messages.some((m) => m.includes('read it all')));
    const wake = transcript[0] ?? '';
    expect(wake).toContain('look at these');
    expect(wake).toContain('SECRET-MARK budget is 42');
    // A text over the inline limit is not shown at all: it is on the computer and the note says where.
    expect(wake).not.toContain('HEAD-MARK');
    expect(wake).not.toContain('TAIL-MARK');
    expect(wake).toContain(`is at /juno/uploads/${longText.body.id}/long.txt on your computer`);
    expect(wake).toContain(`is at /juno/uploads/${note.body.id}/notes.txt on your computer`);
    // The transcript row names the image's bytes in the blob store; the bytes are not in Postgres, the model request has them.
    const pngSha = createHash('sha256').update(Buffer.from(PNG_BASE64, 'base64')).digest('hex');
    expect(wake).toContain(`"blobKey":"blobs/${pngSha}"`);
    expect(wake).not.toContain(PNG_BASE64);
    expect(lastModelImages(sessionKey)).toEqual([pngSha]);
    const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 1);
    expect(activity.results[0]?.text).toContain('TAIL-MARK');

    // Another account referencing the same ids is refused: the message is not stored and nothing wakes its agent.
    const intruder = await chat(bob);
    const stolen = await bob.api('POST', `/v1/conversations/${intruder.conversationId}/runs`, aguiInput(`/v1/conversations/${intruder.conversationId}/runs`, { text: 'what is in this?', attachments: [note.body] }));
    expect(stolen.status).toBe(400);
    expect(JSON.stringify(stolen.body)).toContain('ATTACHMENT_NOT_FOUND');
    expect((await bob.api('GET', `/v1/conversations/${intruder.conversationId}/items`)).body.items ?? []).toHaveLength(0);
  });

  it('puts a PDF on the agent\'s computer and tells the agent where, and refuses a file that was never uploaded', async () => {
    const alice = await createAccount('attach-pdf');
    // Not valid UTF-8 on purpose: the agent cannot be shown this, only told where it is. The NUL byte (real PDFs
    // have them) used to fail the run once files.read returned it: jsonb rejects U+0000.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\nRESUME-MARK\n'), Buffer.from([255, 254, 253, 0]), Buffer.from('\n%%EOF')]);
    const upload = await alice.api('POST', '/v1/uploads', { name: 'My Resume (final).pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64') });
    expect(upload.status).toBe(201);

    const { conversationId, sessionKey } = await chat(alice);
    const never = await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'here', attachments: [{ id: 'resume.pdf-1-0', name: 'resume.pdf', kind: 'file' }] }));
    expect(never.status).toBe(400);

    const where = `/juno/uploads/${upload.body.id}/My Resume (final).pdf`;
    scriptModel(sessionKey, [
      { toolCalls: [toolCall('open-1', 'files.read', { path: where })] },
      { text: 'opened it' },
    ]);
    expect((await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'my resume', attachments: [upload.body] }))).status).toBe(202);
    const transcript = await waitForTranscript(sessionKey, (messages) => messages.some((m) => m.includes('opened it')));
    const wake = transcript[0] ?? '';
    expect(wake).toContain('my resume');
    expect(wake).toContain(`The user attached \\"My Resume (final).pdf\\" (application/pdf, ${String(pdf.length)} B)`);
    expect(wake).toContain(where);
    // The platform skills that read PDFs are not on the test computer, so the text is not shown; the file is there for the agent's tools.
    expect(wake).not.toContain('RESUME-MARK');
    const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 1);
    expect(activity.results[0]?.text).toContain('RESUME-MARK');
  });
});
