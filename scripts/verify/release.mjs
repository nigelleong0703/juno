import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const mode=process.argv[2];
const json=p=>JSON.parse(readFileSync(p,'utf8'));
if(mode==='workspace'){
 assert.ok(existsSync('pnpm-workspace.yaml'),'root workspace missing');
 for(const dir of ['backend','frontend']) for(const file of ['pnpm-lock.yaml','pnpm-workspace.yaml']) assert.ok(!existsSync(dir+'/'+file),'nested workspace/lockfile must not override the public root: '+dir+'/'+file);
 for(const p of ['frontend/packages/client/package.json','frontend/packages/desktop/package.json']) assert.ok(!/git\+ssh:|github.com.nigelleong0703.juno-backend/.test(readFileSync(p,'utf8')),'private repo dependency in '+p);
 const r=spawnSync('pnpm',['--filter','@agent-desktop/web','build'],{stdio:'inherit'}); assert.equal(r.status,0,'real web build failed');
}else if(mode==='deploy'){
 assert.ok(existsSync('deploy/compose.yml'),'server compose missing');
 const r=spawnSync('node',['deploy/setup.mjs','--check'],{stdio:'inherit'}); assert.equal(r.status,0,'deployment self-check failed');
}else throw new Error('unknown verify mode');
console.log(mode+' release pin passed');
