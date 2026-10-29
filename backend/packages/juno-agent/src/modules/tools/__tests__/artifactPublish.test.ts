import { describe, expect, it } from 'vitest';
import type { LibraryDocument } from '../../../contracts/index.js';
import { addVersion, cspSidecarPath, kindForRender, mimeTypeForName, parseCspSidecar } from '../tools/artifactPublish.js';
import { previewPlan } from '../tools/artifactPreview.js';

describe('artifact_publish pure rules', () => {
  it('names the sidecar next to the page', () => {
    expect(cspSidecarPath('/workspace/trip.html')).toBe('/workspace/trip.csp.json');
    expect(cspSidecarPath('/workspace/my.page/a.b.htm')).toBe('/workspace/my.page/a.b.csp.json');
  });

  it('accepts a sidecar of https origins and says why it refuses anything else', () => {
    expect(parseCspSidecar('{"resourceDomains":["https://cdn.jsdelivr.net"]}')).toEqual({ ok: true, csp: { resourceDomains: ['https://cdn.jsdelivr.net'] } });
    expect(parseCspSidecar('nope')).toMatchObject({ ok: false });
    expect(parseCspSidecar('{"resourceDomains":["http://cdn.example"]}')).toMatchObject({ ok: false });
    expect(parseCspSidecar('{"resourceDomains":["https://a.com/x"]}')).toMatchObject({ ok: false });
    expect(parseCspSidecar('{}')).toMatchObject({ ok: false });
  });

  it('maps names to mime types and library kinds', () => {
    expect(mimeTypeForName('a.HTML')).toBe('text/html');
    expect(mimeTypeForName('a.md')).toBe('text/markdown');
    expect(mimeTypeForName('a.xyz')).toBe('application/octet-stream');
    expect(kindForRender('html', 'a.html')).toBe('canvas');
    expect(kindForRender('image', 'a.png')).toBe('image');
    expect(kindForRender('file', 'a.docx')).toBe('document');
    expect(kindForRender('video', 'a.mp4')).toBe('file');
  });

  it('plans previews: Office gets a PDF and a thumbnail, PDF and HTML a thumbnail, the rest nothing', () => {
    expect(previewPlan('a.docx')).toEqual({ convert: true, thumbnail: true, page: false });
    expect(previewPlan('a.XLSX')).toEqual({ convert: true, thumbnail: true, page: false });
    expect(previewPlan('a.pdf')).toEqual({ convert: false, thumbnail: true, page: false });
    expect(previewPlan('a.md')).toEqual({ convert: false, thumbnail: false, page: false });
    expect(previewPlan('a.html')).toEqual({ convert: false, thumbnail: true, page: true });
  });
});

describe('addVersion', () => {
  const base: Omit<LibraryDocument, 'name' | 'kind' | 'mimeType' | 'sizeBytes' | 'updatedAt' | 'render' | 'version' | 'versions'> = {
    id: 'lib_1', shared: 'private', source: 'agent', tags: [], createdAt: '2026-10-14T00:00:00.000Z', pinned: false,
  };
  const input = (n: number, title: string, bytes: number) => ({
    title, render: 'html' as const, kind: 'canvas' as const, mimeType: 'text/html', sizeBytes: bytes, at: `2026-10-14T00:0${n}:00.000Z`, base,
    make: (version: number) => ({ version, fileRef: `af_${n}`, sizeBytes: bytes, mimeType: 'text/html', createdAt: `2026-10-14T00:0${n}:00.000Z` }),
  });

  it('starts at version 1 and appends later versions oldest first, moving the row to the newest', () => {
    const first = addVersion(null, input(1, 'Trip', 10));
    expect(first.artifact).toMatchObject({ id: 'lib_1', name: 'Trip', version: 1, sizeBytes: 10, createdAt: base.createdAt });
    expect(first.artifact.versions?.map((v) => v.version)).toEqual([1]);
    const second = addVersion(first.artifact, input(2, 'Trip v2', 25));
    expect(second.version.version).toBe(2);
    expect(second.artifact).toMatchObject({ name: 'Trip v2', version: 2, sizeBytes: 25, updatedAt: '2026-10-14T00:02:00.000Z', createdAt: base.createdAt });
    expect(second.artifact.versions?.map((v) => [v.version, v.fileRef])).toEqual([[1, 'af_1'], [2, 'af_2']]);
    expect(first.artifact.versions).toHaveLength(1);
  });
});
