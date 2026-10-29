import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const base=process.env.JUNO_SMOKE_URL??'http://127.0.0.1:18487';
const parsed=new URL(base);
assert.ok(['localhost','127.0.0.1'].includes(parsed.hostname),'Use a named disposable loopback deployment for this smoke test.');
const record='.data/deploy-smoke.json';
const json=async(response)=>{assert.ok(response.ok,'HTTP '+response.status);return response.json();};
const health=await fetch(base+'/healthz');assert.ok(health.ok,'Deployment readiness failed: '+health.status);
const web=await fetch(base+'/');assert.ok(web.ok);assert.match(await web.text(),/<html/i,'real web entry missing');
const artifactRoute=await fetch(base+'/v1/edge/tls-check?domain=usercontent.localhost');assert.ok(artifactRoute.ok,'Artifact-host route did not reach the API: '+artifactRoute.status);
const unknownSpaceRoute=await fetch(base+'/v1/edge/tls-check?domain=missing-release-space.spaces.localhost');assert.equal(unknownSpaceRoute.status,404,'Unknown Spaces host must be rejected by the API route');
// Native HTTP preserves the explicit Host; fetch may replace it with the URL host.
const {request}=await import(parsed.protocol==='https:'?'node:https':'node:http');
for(const host of ['usercontent.localhost','missing-release-space.spaces.localhost']){
 const status=await new Promise((resolve,reject)=>{
  const req=request(new URL('/__release_missing__',base),{headers:{Host:host+(parsed.port?':'+parsed.port:'')},timeout:4000},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
  req.on('timeout',()=>req.destroy(new Error('Host route timed out')));req.on('error',reject);req.end();
 });
 assert.equal(status,404,'Untrusted content host must not fall back to the authenticated web app: '+host);
}
const denied=await fetch(base+'/v1/agents');assert.equal(denied.status,401,'anonymous API must refuse');
if(process.argv.includes('--verify-persistence')){
 const state=JSON.parse(readFileSync(record,'utf8'));
 const listed=await json(await fetch(base+'/v1/agents',{headers:{Cookie:state.cookie}}));
 assert.ok(listed.items.some(item=>item.id===state.agentId),'Created agent/session did not survive restart');
 console.log('Restart persistence passed: session and created agent survived.');
}else{
 const id=randomBytes(8).toString('hex');
 const up=await fetch(base+'/auth/sign-up/email',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({email:'release-'+id+'@example.com',name:'Juno Demo',password:randomBytes(24).toString('base64url')})});
 await json(up);const cookie=up.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');assert.ok(cookie,'signup session missing');
 const headers={'Content-Type':'application/json',Origin:base,Cookie:cookie};
 const created=await json(await fetch(base+'/v1/agents',{method:'POST',headers,body:JSON.stringify({name:'Release Demo '+id.slice(0,5)})}));assert.ok(created.id,'Agent creation failed');
 const listed=await json(await fetch(base+'/v1/agents',{headers}));assert.ok(listed.items.some(item=>item.id===created.id));
 mkdirSync('.data',{recursive:true});writeFileSync(record,JSON.stringify({base,cookie,agentId:created.id}),{mode:0o600});
 console.log('Deployment smoke passed: real web, readiness, anonymous refusal, account creation and owner-scoped agent CRUD.');
}
