#!/usr/bin/env node
/**
 * One source for every data format.
 *
 * The public data formats (zod schemas and their types) are owned by the backend repository's
 * `@agent-desktop/public-contracts` package, which this repo installs by a pinned git tag. This fails when:
 *   1. the client grows a copy of the protocol again (models/, api.ts, events.ts), or
 *   2. any file here defines a schema under a public schema's name, or
 *   3. code imports the package by a relative path into a backend checkout, or uses the old
 *      `@agent-desktop/contracts` name instead of `@agent-desktop/public-contracts`.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const publicDir = join(root, 'packages', 'client', 'node_modules', '@agent-desktop', 'public-contracts', 'src');
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'ios', '.turbo', 'coverage']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const problems = [];
if (!existsSync(publicDir)) {
  console.error(`single-source check failed: ${relative(root, publicDir)} is missing; run pnpm install`);
  process.exit(1);
}

const clientSrc = join(root, 'packages', 'client', 'src');
for (const copy of ['models', 'api.ts', 'events.ts']) {
  if (existsSync(join(clientSrc, copy))) problems.push(`packages/client/src/${copy} is a copy of the protocol: import @agent-desktop/public-contracts instead`);
}

const publicNames = new Set();
for (const file of walk(publicDir)) {
  for (const match of readFileSync(file, 'utf8').matchAll(/export const (\w+Schema)\s*=/g)) publicNames.add(match[1]);
}
const sources = [...walk(join(root, 'packages')), ...walk(join(root, 'tests'))];
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+(\w+Schema)\s*=\s*z\./g)) {
    if (publicNames.has(match[1])) problems.push(`${relative(root, file)} redefines ${match[1]}: import it from @agent-desktop/public-contracts`);
  }
  for (const match of text.matchAll(/from\s+['"]((?:\.\.\/)+backend\/[^'"]*)['"]/g)) {
    problems.push(`${relative(root, file)} imports ${match[1]} by path: use the package (@agent-desktop/public-contracts)`);
  }
  if (/from\s+['"]@agent-desktop\/contracts(?:\/[^'"]*)?['"]/.test(text)) problems.push(`${relative(root, file)} uses the old @agent-desktop/contracts name: import @agent-desktop/public-contracts`);
}

if (problems.length > 0) {
  console.error('single-source check failed:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`single-source check passed (${publicNames.size} public schemas, ${sources.length} files scanned)`);
