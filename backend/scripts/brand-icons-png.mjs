// Pre-renders packages/api/assets/brands/*.svg to 192x192 (3x) transparent PNGs next to them, each icon fitted and centred.
// No dependency is added to the repo: install the rasteriser in a scratch dir and point at it.
//   mkdir /tmp/resvg && (cd /tmp/resvg && npm init -y && npm i @resvg/resvg-js) && node scripts/brand-icons-png.mjs /tmp/resvg
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scratch = process.argv[2];
if (!scratch) throw new Error('usage: node scripts/brand-icons-png.mjs <dir with @resvg/resvg-js installed>');
const { Resvg } = createRequire(join(resolve(scratch), 'x.js'))('@resvg/resvg-js');
const dir = join(dirname(fileURLToPath(import.meta.url)), '../packages/api/assets/brands');
const SIZE = 192;
for (const file of readdirSync(dir).filter((name) => name.endsWith('.svg'))) {
  // A fixed square size on the root: the viewBox is then fitted and centred inside it.
  const svg = readFileSync(join(dir, file), 'utf8').replace(/<svg\b([^>]*)>/, (_, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="${SIZE}" height="${SIZE}">`);
  writeFileSync(join(dir, file.replace(/\.svg$/, '.png')), new Resvg(svg).render().asPng());
}
