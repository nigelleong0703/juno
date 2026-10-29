import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryBlobStore, createMemoryStore } from '@agent-desktop/db';
import { blobKeyFor, type LibraryDocument, type Store } from '@agent-desktop/contracts';
import { fileDownloadSchema } from '@agent-desktop/public-contracts';
import { createApiApp } from '../server.js';

const owner='qa-owner', other='qa-other', bytes=Buffer.from([0,255,128,65,10]);
const at='2026-10-07T00:00:00Z';
const blobs=createMemoryBlobStore();
function file(content=bytes): LibraryDocument {
 const sha256=createHash('sha256').update(content).digest('hex');
 blobs.objects.set(blobKeyFor(sha256),content);
 return {id:'qa-file',name:'result.bin',kind:'file',mimeType:'application/octet-stream',sizeBytes:content.length,source:'agent',shared:'private',tags:[],pinned:false,createdAt:at,updatedAt:at,blobKey:blobKeyFor(sha256),sha256};
}
describe('owner file downloads',()=>{
 let store: Store;
 let scoped: Store;
 let app: ReturnType<typeof createApiApp>;
 beforeEach(async()=>{
  store=createMemoryStore();
  if(!store.forOwner) throw new Error('Owner scope required');
  scoped=store.forOwner(owner);await scoped.put('library',file());
  app=createApiApp({store,blobs,agentdUrl:'http://unused.invalid',internalToken:'fixture',auth:{info:{mode:'account',providers:['credential']},handle:async()=>new Response('',{status:404}),resolve:async(req)=>{const token=req.headers.get('authorization');return token==='Bearer '+owner?{ownerId:owner}:token==='Bearer '+other?{ownerId:other}:null;}}});
 });
 function call(path:string,who=owner,method='GET',body?:unknown){return app.request(path,{method,headers:{authorization:'Bearer '+who,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
 it('returns exact binary bytes and integrity metadata',async()=>{
  const res=await call('/v1/library/qa-file/download');expect(res.status).toBe(200);
  const data=fileDownloadSchema.parse(await res.json());expect(Buffer.from(data.contentBase64,'base64')).toEqual(bytes);expect(data.sha256).toBe(file().sha256);expect(data.sizeBytes).toBe(bytes.length);
 });
 it('keeps bytes and hash out of list, metadata and pin responses',async()=>{
  for(const [path,method,body] of [['/v1/library','GET',undefined],['/v1/library/qa-file','GET',undefined],['/v1/library/qa-file/pinned','POST',{pinned:true}]] as const){
   const res=await call(path,owner,method,body);expect(res.status).toBe(200);const text=await res.text();expect(text).not.toContain('contentBase64');expect(text).not.toContain('blobKey');expect(text).not.toContain('sha256');expect(text).not.toContain(bytes.toString('base64'));
  }
 });
 it('denies foreign owners and anonymous requests',async()=>{
  expect((await call('/v1/library/qa-file/download',other)).status).toBe(404);
  expect((await app.request('/v1/library/qa-file/download')).status).toBe(401);
 });
 it('deleting a document deletes its drafts, and only its own',async()=>{
  const doc={...file(),id:'qa-doc',render:'doc' as const,kind:'document' as const,versions:[]};
  await scoped.put('library',doc);
  const draft={id:'qa-draft',documentId:'qa-doc',baseVersion:0,revision:1,title:'t',author:'person' as const,sizeBytes:1,sha256:'a',status:'pending' as const,createdAt:at,updatedAt:at,blobKey:'blobs/a'};
  await scoped.put('documentDrafts',draft,{parentId:'qa-doc',status:'pending'});
  await scoped.put('documentDrafts',{...draft,id:'qa-other-draft',documentId:'qa-file'},{parentId:'qa-file',status:'pending'});
  expect((await call('/v1/library/qa-doc',owner,'DELETE')).status).toBe(200);
  expect(await scoped.get('documentDrafts','qa-draft')).toBeNull();
  expect(await scoped.get('documentDrafts','qa-other-draft')).not.toBeNull();
 });
 it('downloads valid empty files',async()=>{
  await scoped.put('library',file(Buffer.alloc(0)));const res=await call('/v1/library/qa-file/download');expect(res.status).toBe(200);expect(fileDownloadSchema.parse(await res.json()).contentBase64).toBe('');
 });
 it('reports legacy files without saved bytes unavailable',async()=>{
  const {blobKey:_blobKey,sha256:_sha256,...metadata}=file();await scoped.put('library',metadata);
  const res=await call('/v1/library/qa-file/download');expect(res.status).toBe(404);expect(await res.text()).toContain('FILE_UNAVAILABLE');
 });
 it.each([{blobKey:'blobs/missing'},{sizeBytes:100},{sha256:'0'.repeat(64)},{sizeBytes:10*1024*1024+1}])('refuses missing, corrupt or oversized saved data',async(patch)=>{
  await scoped.patch('library','qa-file',patch);const res=await call('/v1/library/qa-file/download');expect(res.status).toBe(404);expect(await res.text()).toContain('FILE_UNAVAILABLE');
 });
});
