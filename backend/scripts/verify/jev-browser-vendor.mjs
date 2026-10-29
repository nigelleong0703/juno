// Verify the pinned decision code, without starting a browser or calling a model.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {UpstreamGoalSession} from '../../packages/juno-agent/third-party/jev-browser/core.mjs';
const dir=new URL('../../packages/juno-agent/third-party/jev-browser/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',dir),'utf8'));
const source=process.argv[2]?readFileSync(process.argv[2]+'/src/session.mjs','utf8'):null;
for(const [name,hash]of Object.entries(manifest.methods)){
 const text=UpstreamGoalSession.prototype[name].toString();
 assert.equal(createHash('sha256').update(text).digest('hex'),hash,'changed upstream method '+name);
 if(source)assert(source.includes(text),'method differs from original: '+name);
}
if(process.argv[2])for(const file of ['page-model.mjs','prune.mjs'])assert(readFileSync(new URL(file,dir)).equals(readFileSync(process.argv[2]+'/src/'+file)),file+' differs');
const scripts = readFileSync(new URL('../../packages/sandbox-image/files/agent_browser_jev_scripts.py', import.meta.url), 'utf8');
for(const [name,hash]of Object.entries(manifest.pageScripts??{})){
 const line=scripts.split('\n').find(l=>l.startsWith(name+' = '));assert(line,'missing page script '+name);
 const code=JSON.parse(line.slice(name.length+3));assert.equal(createHash('sha256').update(code).digest('hex'),hash,'changed upstream page script '+name);
 if(process.argv[2]){const file=name==='ENUMERATE'?'page-script.mjs':'session.mjs';assert(readFileSync(process.argv[2]+'/src/'+file,'utf8').includes(code),'page script differs: '+name);}
}
console.log(JSON.stringify({unchangedPageScripts:Object.keys(manifest.pageScripts??{}).length,commit:manifest.commit,unchangedMethods:Object.keys(manifest.methods).length,originalSourceCompared:source!==null}));
