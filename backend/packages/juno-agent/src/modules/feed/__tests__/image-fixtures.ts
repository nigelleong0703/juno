/** Tiny in-memory images (headers only) and a fake fetch that serves pages and pictures by URL. */
import type { SafeFetchDeps } from '../../tools/net/safeFetch.js';

export function jpeg(width: number, height: number, filler = 0): Buffer {
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 0x08]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), sof, Buffer.alloc(64, filler)]);
}

export function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

export const svg = (): Buffer => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"></svg>');

/** Pages: url -> html; images: url -> bytes. Everything resolves to a public address. */
export function fakeWeb(pages: Record<string, string>, images: Record<string, Buffer>): SafeFetchDeps {
  return {
    resolve: async () => [{ address: '93.184.216.34', family: 4 as const }],
    request: async (hop) => {
      const url = hop.url.href;
      const image = images[url];
      if (image !== undefined) return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: image, truncated: false };
      const page = pages[url];
      if (page !== undefined) return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(page), truncated: false };
      return { status: 404, headers: {}, body: Buffer.alloc(0), truncated: false };
    },
  };
}
