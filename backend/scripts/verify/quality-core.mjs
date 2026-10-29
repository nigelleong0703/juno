// Lead-owned AST checks for core source quality; tests are validated separately.
import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const failures = [];
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}
for (const path of ['packages/juno-agent/src/execution/brain', 'packages/juno-agent/src/execution/harness', 'packages/juno-agent/src/execution/infrastructure', 'packages/juno-agent/src/execution/provider.ts', 'packages/juno-agent/src/ports/computer', 'packages/juno-agent/src/index.ts', 'packages/juno-agent/src/runtime.ts', 'packages/juno-agent/src/owner-context.ts'].flatMap(path => path.endsWith('.ts') ? [path] : files(path))) {
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
    const fail = label => failures.push(`${path}:${line}: ${label}`);
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && node.type.getText(ast) !== 'const') fail('type assertion');
    if (node.kind === ts.SyntaxKind.AnyKeyword) fail('any type');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) fail('dynamic import');
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'console') fail('console call');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (source.includes('@ts-ignore') || source.includes('@ts-nocheck')) failures.push(`${path}: ignored types`);
}
if (failures.length) {
  console.error(failures.slice(0, 30).join('\n'));
  console.error(`FAIL - ${failures.length} core quality violations`);
  process.exit(1);
}
console.log('ok - core sources: no assertions/any/console/dynamic imports');
