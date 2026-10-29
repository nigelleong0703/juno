import assert from 'node:assert/strict';
import {readFileSync,statSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const problems=[];
const secrets=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}/,/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{28,}/,/\bxox[baprs]-[A-Za-z0-9-]{20,}/];
for(const path of paths){
 if(/(^|\/)(?:node_modules|\.data|DerivedData|xcuserdata)(?:\/|$)|\.(?:p12|mobileprovision|sqlite|log)$/.test(path)) problems.push(path+': private/generated file');
 if(/(^|\/)\.env(?:$|\.)/.test(path)&&!path.endsWith('.example')) problems.push(path+': environment file');
 if(statSync(path).size>10_000_000) problems.push(path+': large file should be a release asset');
 if(statSync(path).size>2_000_000) continue;
 const text=readFileSync(path,'utf8');
 if(secrets.some(pattern=>pattern.test(text))) problems.push(path+': potential credential');
 if(/package\.json$/.test(path)&&/git\+ssh:|github.com[:/]nigelleong0703\/juno-(?:backend|frontend)/.test(text)) problems.push(path+': private repository dependency');
}
assert.deepEqual(problems,[],problems.join('\n'));
console.log('Public-source scan passed ('+paths.length+' files; path-only reporting).');
