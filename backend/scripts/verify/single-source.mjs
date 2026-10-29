#!/usr/bin/env node
/**
 * One source for every data format.
 *
 * The public data formats (zod schemas and their types) live ONLY in packages/public-contracts/src
 * and are imported as `@agent-desktop/public-contracts`. Clients (frontend repo) consume the same
 * package by a pinned git tag. This fails when:
 *   1. any file outside public-contracts (and the internal seams in juno-agent/src/contracts) defines a schema under a public schema's name, or
 *   2. any package reaches into public-contracts source by a relative path instead of the package.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const publicDir = join(root, 'packages', 'public-contracts', 'src');
const internalContractsDir = join(root, 'packages', 'juno-agent', 'src', 'contracts');
const SKIP = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);

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

const publicNames = new Set();
for (const file of walk(publicDir)) {
  for (const match of readFileSync(file, 'utf8').matchAll(/export const (\w+Schema)\s*=/g)) publicNames.add(match[1]);
}
const sources = walk(join(root, 'packages')).filter((file) => !file.startsWith(publicDir + '/') && !file.startsWith(internalContractsDir + '/'));
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/(?:^|\n)\s*(?:export\s+)?const\s+(\w+Schema)\s*=\s*z\./g)) {
    if (publicNames.has(match[1])) problems.push(`${relative(root, file)} redefines ${match[1]}: import it from @agent-desktop/public-contracts`);
  }
  for (const match of text.matchAll(/from\s+['"]((?:\.\.\/)+public-contracts\/[^'"]*)['"]/g)) {
    problems.push(`${relative(root, file)} imports ${match[1]} by path: use the package (@agent-desktop/public-contracts)`);
  }
}

if (problems.length > 0) {
  console.error('single-source check failed:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`single-source check passed (${publicNames.size} public schemas, ${sources.length} files scanned)`);
