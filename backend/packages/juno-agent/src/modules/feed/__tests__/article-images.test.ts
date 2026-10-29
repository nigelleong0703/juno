/** The article image parser: renderer parity, no unverified image slips through, rewrite preserves meaning. */
import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { containsHtmlImage, extractMarkdownImageRefs, rewriteMarkdownImageUrls } from '../articleImages.js';

const urls = (body: string): string[] => extractMarkdownImageRefs(body).map((ref) => ref.url);

/** Every image the reference parser loads must be extracted, at its exact token. */
function astUrls(body: string): string[] {
  const defs = new Map<string, string>();
  const images: string[] = [];
  const pending: string[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === 'definition') {
      if (!defs.has(node.identifier)) defs.set(node.identifier, node.url);
    }
    if (node.type === 'image') images.push(node.url);
    if (node.type === 'imageReference') pending.push(node.identifier);
    if ('children' in node) {
      for (const child of node.children) walk(child);
    }
  };
  walk(fromMarkdown(body));
  return images.concat(pending.flatMap((key) => defs.get(key) ?? []));
}

describe('extractMarkdownImageRefs', () => {
  it('finds inline and reference images with exact destination ranges', () => {
    const body = 'Before.\n\n![Alt](https://img.example/a.jpg)\n\nAfter.';
    const refs = extractMarkdownImageRefs(body);
    expect(refs).toHaveLength(1);
    expect(body.slice(refs[0]?.start, refs[0]?.end)).toBe('https://img.example/a.jpg');
  });

  it('resolves a definition split across lines with an indented destination (the bypass case)', () => {
    const body = 'Before.\n\n![Chart][ref]\n\n[ref]:\n  https://127.0.0.1/chart.png\n';
    expect(urls(body)).toEqual(['https://127.0.0.1/chart.png']);
  });

  it('matches the reference parser on every corpus form', () => {
    const bodies = [
      '![alt](https://images.example/a.png)',
      '![alt][a]\n\n[a]:\n  https://images.example/a.png',
      '> ![alt][a]\n>\n> [a]:\n>   https://images.example/a.png',
      '- ![alt][a]\n\n  [a]:\n    https://images.example/a.png',
      '![alt][a]\n\n[a]: <https://images.example/a.png> "title"',
      '![a](https://images.example/a\\(1\\).png "title")',
      '![a](https://images.example/a.png?x=1&amp;y=2)',
      '![a](https://images.example/a.png)\n\n````\n![b](https://private.example/x)\n```\n````',
      '![a](https://images.example/a.png)\n\n[ref]: https://news.example/story',
    ];
    for (const body of bodies) expect(urls(body)).toEqual(astUrls(body));
  });

  it('skips escaped bangs and code, and ignores references without definitions', () => {
    expect(urls('A \\![No](https://img.example/no.jpg) B')).toEqual([]);
    expect(urls('```\n![No](https://img.example/no.jpg)\n```\n\n![Yes](https://img.example/yes.jpg)')).toEqual(['https://img.example/yes.jpg']);
    expect(urls('`![No](https://img.example/no.jpg)`')).toEqual([]);
    expect(urls('![N][missing] plain')).toEqual([]);
  });

  it('decodes entities so verification sees the real host', () => {
    expect(urls('![E](https://127&#46;0&#46;0&#46;1/x.jpg)')).toEqual(['https://127.0.0.1/x.jpg']);
  });

  it('keeps the first of duplicate definitions', () => {
    expect(urls('![A][r]\n\n[r]: https://one.example/1.jpg\n\n[r]: https://two.example/2.jpg')).toEqual(['https://one.example/1.jpg']);
  });
});

describe('rewriteMarkdownImageUrls', () => {
  it('splices only destination tokens and keeps prose and citations exact', () => {
    const body = '![a](https://a.example/1.jpg)\n\nSee [the story](https://news.example/s).\n\n![b][r]\n\n[r]: https://b.example/2.jpg';
    expect(rewriteMarkdownImageUrls(body, (url) => 'signed:' + url)).toBe(
      '![a](signed:https://a.example/1.jpg)\n\nSee [the story](https://news.example/s).\n\n![b][r]\n\n[r]: signed:https://b.example/2.jpg',
    );
  });

  it('keeps a blockquoted multiline reference renderable with the signed URL', () => {
    const body = '> ![alt][a]\n>\n> [a]:\n>   https://images.example/a.png';
    const rewritten = rewriteMarkdownImageUrls(body, () => 'https://juno.example/v1/media/test');
    expect(astUrls(rewritten)).toEqual(['https://juno.example/v1/media/test']);
  });

  it('rewrites a shared definition once for two uses', () => {
    const body = '[ref]:\n  https://a.example/old.jpg\n\n![A][ref]\n\n![B][ref]\n';
    const rewritten = rewriteMarkdownImageUrls(body, (url) => 'signed:' + url);
    expect(rewritten).toBe('[ref]:\n  signed:https://a.example/old.jpg\n\n![A][ref]\n\n![B][ref]\n');
    expect(astUrls(rewritten)).toEqual(['signed:https://a.example/old.jpg', 'signed:https://a.example/old.jpg']);
  });
});

describe('containsHtmlImage', () => {
  it('reports img tags and ignores markdown images and code', () => {
    expect(containsHtmlImage('Text <img src="https://x.example/y.jpg"> here')).toBe(true);
    expect(containsHtmlImage('Text ![a](https://x.example/a.jpg) here')).toBe(false);
    expect(containsHtmlImage('`<img src="x">`')).toBe(false);
  });
});
