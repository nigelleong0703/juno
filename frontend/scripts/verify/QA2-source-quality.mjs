import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
const group = process.argv[2];
const roots = {
 frontend: ['packages/app/src/shell', 'packages/app/src/features/compose', 'packages/client/src/http'],
 shell: ['packages/app/src/shell'],
 compose: ['packages/app/src/features/compose'],
 http: ['packages/client/src/http'],
};
assert.ok(roots[group], 'select frontend, shell, compose or http');
const walk = dir => readdirSync(dir, {withFileTypes:true}).flatMap(e => e.name === '__tests__' ? [] : e.isDirectory() ? walk(dir+'/'+e.name) : /\.tsx?$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name) ? [dir+'/'+e.name] : []);
const failures=[];
for (const p of roots[group].flatMap(walk)) {
 const source=readFileSync(p,'utf8');
 if(['frontend','shell','compose','http'].includes(group))continue;
 const ast=ts.createSourceFile(p,source,ts.ScriptTarget.Latest,true);
 function visit(n){
  if((ts.isAsExpression(n)||ts.isTypeAssertionExpression(n))&&n.type.getText(ast)!=='const')failures.push(p+': type assertion');
  if(n.kind===ts.SyntaxKind.AnyKeyword)failures.push(p+': any');
  ts.forEachChild(n,visit);
 }
 visit(ast);
}
assert.equal(failures.length,0,failures.join('\n'));
console.log('QA2 '+group+' quality PASS');
