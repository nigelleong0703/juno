import { readdirSync, readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { resolve, relative } from 'node:path';
const mode = process.argv[2] ?? 'runtime';
const walk = dir => readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
if (mode === 'runtime') {
 const files = ['packages/app/src','packages/web/src','packages/desktop/src/renderer/src'].flatMap(walk).filter(p => /\.(tsx?|mjs)$/.test(p) && !/(?:__tests__|\.test\.|\.stories\.|\/dev\/|\/dev\.ts$)/.test(p));
 const bad = files.filter(p => /createMockClient|isMockClient|useMock|MockDesktop|@agent-desktop\/client\/(mock|testing)/.test(readFileSync(p,'utf8')));
 assert.deepEqual(bad, [], 'Product source still contains demo/mock runtime');
} else if (mode === 'identity') {
 for (const file of ['packages/app/src/lib/people.ts','packages/app/src/auth/AuthContext.tsx','packages/app/src/components/AccountGate.tsx']) {
  assert.ok(!/user-robin|member-robin|member-priya|robin@example/.test(readFileSync(file,'utf8')), `Demo identity remains in product: ${file}`);
 }
} else if (mode === 'graph') {
 const options = {moduleResolution:ts.ModuleResolutionKind.Bundler, module:ts.ModuleKind.ESNext, allowJs:true, jsx:ts.JsxEmit.ReactJSX};
 const seen = new Set();
 function visit(file) {
  file = resolve(file);
  if (seen.has(file)) return;
  seen.add(file);
  const path = relative(process.cwd(),file);
  assert.ok(!path.startsWith('tests/') && !/\/(?:mock|__tests__|design-gallery|dev)\//.test(path), `Test/demo code reachable from product: ${path}`);
  const ast = ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  for (const node of ast.statements) {
   if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) || node.isTypeOnly || node.importClause?.isTypeOnly) continue;
   const spec = node.moduleSpecifier;
   if (!spec || !ts.isStringLiteral(spec)) continue;
   assert.ok(!spec.text.includes('test-fixtures'), `Test fixture import reachable: ${path}`);
   const target = ts.resolveModuleName(spec.text,file,options,ts.sys).resolvedModule;
   if (spec.text.startsWith('@agent-desktop/')) assert.ok(target, `Unresolved product workspace import: ${path} -> ${spec.text}`);
   if (!target || target.isExternalLibraryImport || target.resolvedFileName.endsWith('.d.ts')) {
    if (!spec.text.startsWith('@agent-desktop/')) continue;
   }
   if (target && !target.resolvedFileName.endsWith('.d.ts')) visit(target.resolvedFileName);
  }
 }
 visit('packages/web/src/main.tsx');
 visit('packages/desktop/src/renderer/src/main.tsx');
 console.log(`Inspected ${seen.size} reachable source modules`);
} else {
 assert.equal(existsSync('packages/client/src/mock'), false, 'Mock implementation must leave product source');
 const pkg = JSON.parse(readFileSync('packages/client/package.json','utf8'));
 assert.equal(pkg.exports?.['./mock'], undefined, 'Remove product mock export');
 const fixtures = existsSync('tests/fixtures') ? walk('tests/fixtures') : [];
 assert.ok(fixtures.some(p => /world\.ts$/.test(p)), 'Preserve world as test fixture');
 assert.ok(fixtures.some(p => /client\.ts$/.test(p)), 'Preserve client as test fixture');
}
console.log(`No product mock ${mode} PASS`);
