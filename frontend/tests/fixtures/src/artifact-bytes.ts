import type { Artifact, ArtifactPart, FileDownload } from '@agent-desktop/client';

/** Bytes the mock serves for published artifacts (BACKEND §5.11): enough to render each card type in the prototype and tests. */

const TRIP_HTML = (v: number) =>
  `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;margin:0;padding:20px;background:#faf8f5;color:#222">` +
  `<h2 style="margin:0 0 12px">Kuala Lumpur trip${v > 1 ? ' (v' + v + ')' : ''}</h2>` +
  `<table style="border-collapse:collapse;width:100%"><tr><th align=left>Day</th><th align=left>Plan</th></tr>` +
  `<tr><td>Fri</td><td>Fly SIN to KUL, Petronas Towers</td></tr><tr><td>Sat</td><td>Batu Caves, street food</td></tr>` +
  `${v > 1 ? '<tr><td>Sun</td><td>Slow breakfast, fly home</td></tr>' : ''}</table>` +
  `<button onclick="this.textContent='Clicked'" style="margin-top:14px;padding:6px 12px">Try me</button></body>`;

const README_MD = (v: number) =>
  `# Launch checklist${v > 1 ? ' v' + v : ''}\n\n- Confirm pricing page copy\n- Smoke-test the signup flow\n- Draft the announcement\n\n` +
  Array.from({ length: 14 }, (_, i) => `${i + 1}. Follow-up item number ${i + 1} with a little more detail so the card has to collapse.`).join('\n') + '\n';

/** A minimal one-page PDF. */
const PDF_TEXT = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 24 80 Td (Quarterly report) Tj ET\nendstream endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF\n';

/** 8x8 grey PNG. */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEXd3d3///8m8ZA3AAAAD0lEQVQI12NgYGD4z8AAAAYBAQDwq4ZPAAAAAElFTkSuQmCC';

const utf8Base64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

export function mockArtifactDownload(artifact: Artifact, version: number, part: ArtifactPart): FileDownload {
  const v = artifact.versions?.find((candidate) => candidate.version === version);
  if (!v) throw new Error(`artifact version not found: ${artifact.id}@${version}`);
  if (part === 'thumbnail') {
    if (!v.thumbnailRef) throw new Error('artifact part not found: thumbnail');
    return { name: 'thumbnail.png', mimeType: 'image/png', contentBase64: PNG_BASE64 };
  }
  if (part === 'preview') {
    if (!v.previewRef) throw new Error('artifact part not found: preview');
    return { name: artifact.name.replace(/\.[^.]+$/, '.pdf'), mimeType: 'application/pdf', contentBase64: btoa(PDF_TEXT) };
  }
  const base = { name: artifact.name, mimeType: v.mimeType };
  if (artifact.render === 'html') return { ...base, contentBase64: utf8Base64(TRIP_HTML(version)) };
  if (v.mimeType === 'text/markdown') return { ...base, contentBase64: utf8Base64(README_MD(version)) };
  if (artifact.render === 'image') return { ...base, contentBase64: PNG_BASE64 };
  return { ...base, contentBase64: btoa(`fixture-bytes:${artifact.id}:${version}`) };
}

export function mockRenderUrl(version: number): { url: string; expiresAt: string } {
  // A data: page keeps the prototype self-contained; the sandbox attribute still makes it an opaque origin.
  return { url: `data:text/html;charset=utf-8,${encodeURIComponent(TRIP_HTML(version))}`, expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
}
