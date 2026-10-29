import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import ts from 'typescript';
const config=ts.readConfigFile('packages/client/tsconfig.json',ts.sys.readFile);
assert.ok(!config.error);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,resolve('packages/client'));
const dir=resolve('packages/client/.data');
mkdirSync(dir,{recursive:true});
const fixture=dir+'/qa2-http-types.ts';
try{
 writeFileSync(fixture,`import type {HttpTransport} from '../src/http/transport.js';
import {z} from 'zod';
declare const http:HttpTransport;
// @ts-expect-error Unparsed network data cannot become a trusted string.
const unparsed:Promise<string> = http.request('/probe','GET');
const parsed:Promise<string> = http.request('/probe','GET',undefined,z.string());
void unparsed;void parsed;
`);
 const program=ts.createProgram([...parsed.fileNames,fixture],{...parsed.options,noEmit:true});
 const errors=ts.getPreEmitDiagnostics(program).filter(d=>d.category===ts.DiagnosticCategory.Error);
 assert.equal(errors.length,0,ts.formatDiagnosticsWithColorAndContext(errors,{getCanonicalFileName:p=>p,getCurrentDirectory:()=>process.cwd(),getNewLine:()=>String.fromCharCode(10)}));
 console.log('QA2 raw HTTP responses remain unknown; schemas alone grant typed output PASS');
}finally{rmSync(fixture,{force:true});}
