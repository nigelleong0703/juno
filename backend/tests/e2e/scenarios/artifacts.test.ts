import { aguiInput } from '../../agui-input.js';
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAccount, docRowsContaining, hostRequest, listenEvents, request, scriptModel, stackUrls, toolCall, waitForIdle, waitForToolActivity, type ScriptedTurn } from '../harness/client';

// Each step chains several file and publish calls on the shared fake computer; with the full suite running in parallel a
// step can take well over the default 30 s (alone the whole test takes a few seconds), so the waits and the test get more room.
const WAIT_MS = 90_000;
vi.setConfig({ testTimeout: 240_000 });

/**
 * Artifacts (BACKEND 5.11): artifact_publish turns a file in the agent's computer into a chat artifact with versions;
 * HTML pages are served by the API under /v1/artifact-pages through a signed short-lived URL with a CSP, and only to the owner's asks.
 *
 * The fake computer holds files in memory. files.write puts the HTML there, and the production file reader (the same
 * python3 script send_file uses) runs for real on that content, so size, base64 and sha256 are not faked.
 */
const PAGE_V1 = '<!doctype html><title>Trip</title><h1>Trip plan v1</h1><script>document.body.dataset.ok = "1"</script>';
const PAGE_V2 = '<!doctype html><title>Trip</title><h1>Trip plan v2</h1>';
const NOTES = '# Notes\n\n- pack socks\n';

const write = (id: string, path: string, content: string): ScriptedTurn => ({ toolCalls: [toolCall(id, 'files.write', { path, content })] });
const publish = (id: string, args: Record<string, unknown>): ScriptedTurn => ({ toolCalls: [toolCall(id, 'artifact_publish', args)] });

/** A render token minted like the API does, to prove the origin refuses expired and forged ones. */
function token(secret: string, claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}

describe('artifacts', () => {
  it('publishes html and md, versions an artifact, and serves html only through the signed page URL', async () => {
    const alice = await createAccount('art-alice');
    const bob = await createAccount('art-bob');
    const agent = await alice.api('POST', '/v1/agents', { name: 'Builder' });
    expect(agent.status).toBe(201);
    const events = await listenEvents(alice.cookie);
    try {
      const created = await alice.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      const conversationId: string = created.body.id;
      const sessionKey = `${agent.body.id}:${conversationId}`;

      // ---- phase 1: an html page with a declared CDN, a refused type, a bad sidecar, a markdown file.
      scriptModel(sessionKey, [
        write('w1', '/workspace/trip.html', PAGE_V1),
        write('w2', '/workspace/trip.csp.json', '{"resourceDomains":["https://cdn.jsdelivr.net"]}'),
        publish('p1', { path: '/workspace/trip.html', title: 'Trip plan' }),
        write('w3', '/workspace/data.csv', 'a,b\n1,2\n'),
        publish('p2', { path: '/workspace/data.csv', title: 'Data' }),
        write('w4', '/workspace/bad.html', '<p>x</p>'),
        write('w5', '/workspace/bad.csp.json', '{"resourceDomains":["http://evil.example"]}'),
        publish('p3', { path: '/workspace/bad.html', title: 'Bad' }),
        write('w6', '/workspace/notes.md', NOTES),
        publish('p4', { path: '/workspace/notes.md', title: 'Notes' }),
        { text: 'published' },
      ]);
      const sent = await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'build me a trip page' }));
      expect(sent.status).toBe(202);
      const activity = await waitForToolActivity(sessionKey, (a) => a.results.filter((r) => r.toolName === 'artifact_publish').length >= 4, WAIT_MS);
      const published = activity.results.filter((r) => r.toolName === 'artifact_publish');
      expect(published.map((r) => r.isError)).toEqual([false, true, true, false]);
      expect(published[1]?.text).toContain('send_file');
      expect(published[2]?.text).toContain('https');

      // The chat has one artifact card per publish, naming artifact and version.
      const items = (await alice.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items as Array<Record<string, any>>;
      const cards = items.filter((item) => item.type === 'artifact');
      expect(cards).toHaveLength(2);
      expect(cards.map((c) => c.version)).toEqual([1, 1]);
      const [pageId, notesId] = cards.map((c) => c.artifactId as string) as [string, string];

      // Each publish left one experience line about the owner (what the agent did, found later by memory_search from another chat).
      const remembered = await alice.api('GET', '/v1/memory/items?limit=100');
      const lines = (remembered.body.items as Array<{ text: string; kind: string; audience: { kind: string } }>).filter((item) => item.kind === 'experience');
      expect(lines.filter((item) => item.text.includes(`artifactId ${pageId},`) && item.text.includes('"Trip plan"') && item.text.includes('/workspace/trip.html'))).toHaveLength(1);
      expect(lines.filter((item) => item.text.includes(`artifactId ${notesId},`) && item.text.includes('/workspace/notes.md'))).toHaveLength(1);
      expect(lines.every((item) => item.audience.kind === 'owner')).toBe(true);

      const page = await alice.api('GET', `/v1/artifacts/${pageId}`);
      expect(page.body).toMatchObject({ id: pageId, name: 'Trip plan', render: 'html', version: 1, kind: 'canvas', mimeType: 'text/html' });
      expect(page.body.versions).toHaveLength(1);
      expect(page.body.versions[0]).toMatchObject({ version: 1, csp: { resourceDomains: ['https://cdn.jsdelivr.net'] } });
      // The page's thumbnail is the browser screenshot made in the computer: the publish reports no note, and the version has the PNG.
      expect(published[0]?.text).not.toContain('Notes:');
      expect(page.body.versions[0].thumbnailRef).toBeTruthy();
      const thumb = await alice.api('GET', `/v1/artifacts/${pageId}/versions/1/download?part=thumbnail`);
      expect(thumb.status).toBe(200);
      expect(thumb.body).toMatchObject({ name: 'trip.png', mimeType: 'image/png' });
      expect(thumb.body.sizeBytes).toBeGreaterThan(0);
      expect(JSON.stringify(page.body)).not.toContain('contentBase64');
      const notes = await alice.api('GET', `/v1/artifacts/${notesId}`);
      expect(notes.body).toMatchObject({ render: 'file', version: 1, kind: 'document', mimeType: 'text/markdown' });
      const notesFile = await alice.api('GET', `/v1/artifacts/${notesId}/versions/1/download`);
      expect(Buffer.from(notesFile.body.contentBase64, 'base64').toString('utf8')).toBe(NOTES);
      expect(notesFile.body).toMatchObject({ name: 'notes.md', mimeType: 'text/markdown' });
      expect((await alice.api('GET', `/v1/artifacts/${notesId}/versions/1/download?part=preview`)).status).toBe(404);
      // The library download of a published artifact serves its newest file.
      const viaLibrary = await alice.api('GET', `/v1/library/${notesId}/download`);
      expect(Buffer.from(viaLibrary.body.contentBase64, 'base64').toString('utf8')).toBe(NOTES);

      // ---- render URL: owner only, HTML only, signed.
      expect((await request('POST', `/v1/artifacts/${pageId}/versions/1/render-url`)).status).toBe(401);
      expect((await bob.api('POST', `/v1/artifacts/${pageId}/versions/1/render-url`)).status).toBe(404);
      expect((await bob.api('GET', `/v1/artifacts/${pageId}`)).status).toBe(404);
      expect((await bob.api('GET', `/v1/artifacts/${pageId}/versions/1/download`)).status).toBe(404);
      expect((await alice.api('POST', `/v1/artifacts/${notesId}/versions/1/render-url`)).status).toBe(400);
      expect((await alice.api('POST', `/v1/artifacts/${pageId}/versions/9/render-url`)).status).toBe(404);

      const minted = await alice.api('POST', `/v1/artifacts/${pageId}/versions/1/render-url`);
      expect(minted.status).toBe(200);
      const url: string = minted.body.url;
      expect(url.startsWith(`http://${stackUrls().artifactHost}/a/`)).toBe(true);
      const pagePath = (t: string) => `/a/${t}`;
      const fetchPage = (path: string, host = stackUrls().artifactHost) => hostRequest(host, path);
      const ttl = Date.parse(minted.body.expiresAt) - Date.now();
      expect(ttl).toBeGreaterThan(50 * 60_000);
      expect(ttl).toBeLessThanOrEqual(60 * 60_000);

      // The artifact host needs no login: the URL is the credential. No cookie goes in, none comes out.
      const pageUrl = new URL(url);
      const served = await fetchPage(pageUrl.pathname);
      expect(served.status).toBe(200);
      expect(served.body).toBe(PAGE_V1);
      expect(served.headers['content-type']).toContain('text/html');
      expect(served.headers['set-cookie']).toBeUndefined();
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['referrer-policy']).toBe('no-referrer');
      expect(served.headers['cache-control']).toBe('private, no-store');
      expect(served.headers['access-control-allow-origin']).toBeUndefined();
      const csp = String(served.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net;");
      expect(csp).toContain('connect-src https://cdn.jsdelivr.net;');
      expect(csp).toContain("form-action 'none'; base-uri 'none'; sandbox allow-scripts");
      expect(csp).toContain(`frame-ancestors ${stackUrls().apiUrl}`);
      // Only that host serves pages, and the host serves nothing but pages: not the api, not the health check.
      const apiHost = new URL(stackUrls().apiUrl).host;
      expect((await fetchPage(pageUrl.pathname, apiHost)).status).toBe(404);
      expect((await fetchPage(`/v1/artifacts/${pageId}`)).status).toBe(404);
      expect((await fetchPage('/healthz')).status).toBe(404);
      expect((await fetchPage('/a/')).status).toBe(404);

      // Forged, re-signed with another key, expired, and truncated tokens are refused.
      const tail = url.slice(-1) === 'A' ? 'B' : 'A';
      expect((await fetchPage(pageUrl.pathname.slice(0, -1) + tail)).status).toBe(404);
      const claims = { artifactId: pageId, version: 1, ownerId: alice.userId };
      const secret = stackUrls().artifactUrlSecret;
      expect((await fetchPage(pagePath(token('wrong-secret', { ...claims, expiresAt: Date.now() + 60_000 })))).status).toBe(404);
      expect((await fetchPage(pagePath(token(secret, { ...claims, expiresAt: Date.now() - 1000 })))).status).toBe(404);
      expect((await fetchPage(pagePath(token(secret, { ...claims, expiresAt: Date.now() + 60_000 })))).status).toBe(200);
      // A valid signature for another owner's id does not reach alice's page.
      expect((await fetchPage(pagePath(token(secret, { ...claims, ownerId: bob.userId, expiresAt: Date.now() + 60_000 })))).status).toBe(404);
      expect((await fetchPage(pageUrl.pathname.slice(0, pageUrl.pathname.lastIndexOf('.')))).status).toBe(404);

      // ---- phase 2: a new version of the same artifact. The transcript holds 11 assistant turns now.
      const filler: ScriptedTurn[] = Array.from({ length: 11 }, () => ({ text: '.' }));
      scriptModel(sessionKey, [
        ...filler,
        write('w7', '/workspace/trip.html', PAGE_V2),
        publish('p5', { path: '/workspace/trip.html', title: 'Trip plan', artifactId: pageId }),
        publish('p6', { path: '/workspace/trip.html', title: 'Nope', artifactId: notesId }),
        { text: 'updated' },
      ]);
      await waitForIdle(events, conversationId); // a message sent during run 1's last model call would steer into it and shift the script
      expect((await alice.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'change the heading' }))).status).toBe(202);
      const second = await waitForToolActivity(sessionKey, (a) => a.results.filter((r) => r.toolName === 'artifact_publish').length >= 6, WAIT_MS);
      const later = second.results.filter((r) => r.toolName === 'artifact_publish').slice(4);
      expect(later.map((r) => r.isError)).toEqual([false, true]);
      expect(later[0]?.text).toContain('version 2');
      expect(later[1]?.text).toContain('same type');

      const update = await events.waitFor((e) => e.data.type === 'artifact.updated' && e.data.artifact.id === pageId && e.data.artifact.version === 2);
      expect(update.data.artifact).toMatchObject({ version: 2, render: 'html' });
      const v2 = await alice.api('GET', `/v1/artifacts/${pageId}`);
      expect(v2.body.version).toBe(2);
      expect(v2.body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
      // The sidecar is still next to the page, so version 2 declares the same origins.
      expect(v2.body.versions[1].csp).toEqual({ resourceDomains: ['https://cdn.jsdelivr.net'] });
      // The chat keeps its single card for the artifact; it shows the newest version.
      const after = (await alice.api('GET', `/v1/conversations/${conversationId}/items?limit=50`)).body.items as Array<Record<string, any>>;
      expect(after.filter((item) => item.type === 'artifact' && item.artifactId === pageId)).toHaveLength(1);

      // Both versions stay retrievable and render what they were.
      const urlV2 = (await alice.api('POST', `/v1/artifacts/${pageId}/versions/2/render-url`)).body.url as string;
      const servedV2 = await fetch(urlV2);
      expect(await servedV2.text()).toBe(PAGE_V2);
      expect(servedV2.headers.get('content-security-policy')).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net;");
      const oldAgain = await fetch((await alice.api('POST', `/v1/artifacts/${pageId}/versions/1/render-url`)).body.url);
      expect(await oldAgain.text()).toBe(PAGE_V1);
      const oldFile = await alice.api('GET', `/v1/artifacts/${pageId}/versions/1/download`);
      expect(Buffer.from(oldFile.body.contentBase64, 'base64').toString('utf8')).toBe(PAGE_V1);
      // The bytes live in the blob store: no artifact or library document carries them.
      expect(await docRowsContaining('artifact_files', 'contentBase64')).toBe(0);
      expect(await docRowsContaining('library', 'contentBase64')).toBe(0);
      expect(await docRowsContaining('artifact_files', Buffer.from(PAGE_V1).toString('base64').slice(0, 40))).toBe(0);
    } finally {
      events.close();
    }
  });
});
