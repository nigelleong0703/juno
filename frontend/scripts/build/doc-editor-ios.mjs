#!/usr/bin/env node
/**
 * Builds the document editor page the iOS app bundles (BACKEND 5.11a, VISUAL "Documents") into
 * `packages/ios/DocEditor/` (git-ignored). Xcode runs it as a pre-build script (`project.yml`), so the page is always the
 * web editor's current source. It skips the build when the output is newer than every source file.
 *
 *   node scripts/build/doc-editor-ios.mjs [--force]
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = join(root, 'packages', 'doc-editor');
const outDir = join(root, 'packages', 'ios', 'DocEditor');
const files = ['editor.js', 'editor.css'];

function newest(dir) {
  let time = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    time = Math.max(time, entry.isDirectory() ? newest(path) : statSync(path).mtimeMs);
  }
  return time;
}

const sources = Math.max(newest(join(pkg, 'src')), newest(join(pkg, 'ios')), statSync(join(pkg, 'vite.ios.config.ts')).mtimeMs, statSync(join(pkg, 'package.json')).mtimeMs);
const built = [...files, 'index.html'].every((name) => existsSync(join(outDir, name))) ? Math.min(...[...files, 'index.html'].map((name) => statSync(join(outDir, name)).mtimeMs)) : 0;

if (!process.argv.includes('--force') && built > sources) {
  console.log('doc-editor-ios: up to date');
  process.exit(0);
}

execFileSync('pnpm', ['exec', 'vite', 'build', '--config', 'vite.ios.config.ts'], { cwd: pkg, stdio: 'inherit' });
mkdirSync(outDir, { recursive: true });
for (const name of files) copyFileSync(join(pkg, 'dist', name), join(outDir, name));
copyFileSync(join(pkg, 'ios', 'index.html'), join(outDir, 'index.html'));
console.log(`doc-editor-ios: wrote ${outDir}`);
