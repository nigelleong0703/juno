import { describe, expect, it } from 'vitest';
import { artifactCspSchema, artifactRenderForName } from '../models/artifact.js';

describe('artifactRenderForName', () => {
  it.each([
    ['trip.html', 'html'],
    ['Trip.HTM', 'html'],
    ['report.pdf', 'file'],
    ['a.docx', 'file'],
    ['a.pptx', 'file'],
    ['a.xlsx', 'file'],
    ['notes.md', 'file'],
    ['card.png', 'image'],
    ['photo.JPG', 'image'],
    ['photo.jpeg', 'image'],
    ['a.webp', 'image'],
    ['a.gif', 'image'],
    ['clip.mp4', 'video'],
    ['clip.webm', 'video'],
  ])('%s renders as %s', (name, render) => {
    expect(artifactRenderForName(name)).toBe(render);
  });

  it('refuses anything else, and names without an extension', () => {
    for (const name of ['data.csv', 'archive.zip', 'script.py', 'noext', 'html', '.html.bak']) expect(artifactRenderForName(name)).toBeUndefined();
  });
});

describe('artifactCspSchema', () => {
  it('accepts https origins only', () => {
    expect(artifactCspSchema.safeParse({ resourceDomains: ['https://cdn.jsdelivr.net', 'https://example.com:8443'] }).success).toBe(true);
    for (const bad of ['http://cdn.jsdelivr.net', 'https://x.com/path', '*', 'https://*.x.com', "https://x.com; script-src 'unsafe-eval'", 'data:', 'cdn.jsdelivr.net', 'https://x.com/']) {
      expect(artifactCspSchema.safeParse({ resourceDomains: [bad] }).success, bad).toBe(false);
    }
  });
});
