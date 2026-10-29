import { createMemoryBlobStore } from '../../../testing/blobs.js';
 import type { Agent, Conversation } from '@agent-desktop/public-contracts';
 import { createHash } from 'node:crypto';
 import { describe, expect, it, beforeEach } from 'vitest';
 import { createMemoryStore } from '../../../testing/store.js';
 import type { Enqueuer, Store, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
 import type { ComputerClient } from '../../../ports/computer/index.js';
 import type { ShellInput, ShellOutput } from '../../../ports/computer/index.js';
 import type { ComputerEnvironment } from '../../../ports/computer/index.js';
 import { createSendFileTool } from '../tools/sendFile.js';
 import { createSendMessageTool } from '../tools/sendMessage.js';
 
 const OWNER = 'user-1';
 const OTHER_OWNER = 'user-2';
 const NOW = '2026-10-06T00:00:00.000Z';
 const LIMIT = 10 * 1024 * 1024;
 
 class StubEnqueuer implements Enqueuer {
   async enqueue() {
     return { accepted: true };
   }
   async stopRun() {}
   async resolveAwakeable() {}
   async scheduleRoutine() {}
 }
 
 function quotedSegments(command: string): string[] {
   const out: string[] = [];
   let i = 0;
   while (i < command.length) {
     const open = command.indexOf("'", i);
     if (open < 0) return out;
     let j = open + 1;
     let cur = '';
     let closed = false;
     while (j < command.length) {
       if (command[j] === "'") {
         if (command.startsWith(String.fromCharCode(39, 92, 39, 39), j)) {
           cur += "'";
           j += 4;
           continue;
         }
         closed = true;
         j += 1;
         break;
       }
       cur += command[j];
       j += 1;
     }
     if (!closed) return out;
     out.push(cur);
     i = j;
   }
   return out;
 }
 
 // Emulates the bounded python3 reader the tool shells out to: the path comes
 // from the last single-quoted argv segment, bytes come from a fake sandbox
 // disk, and stdout is the same JSON shape the real script prints.
 class FakeComputer implements ComputerClient {
   calls: ShellInput[] = [];
   files = new Map<string, Buffer>();
   tamperSha = false;
   async runShell(_agentId: string, input: ShellInput, signal: AbortSignal): Promise<ShellOutput> {
     this.calls.push(input);
     if (signal.aborted) throw new Error('aborted');
     if (!input.command.startsWith('python3 -c ')) {
       return { stdout: '', stderr: 'unexpected command', exitCode: 1 };
     }
     const segments = quotedSegments(input.command);
     const path = segments[segments.length - 1] ?? '';
     const bytes = this.files.get(path);
     if (bytes === undefined) return { stdout: '', stderr: 'No such file', exitCode: 1 };
     if (bytes.length > LIMIT) return { stdout: '', stderr: 'file too large', exitCode: 3 };
     const digest = this.tamperSha ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex');
     return {
       stdout: JSON.stringify({ contentBase64: bytes.toString('base64'), sizeBytes: bytes.length, sha256: digest }),
       stderr: '',
       exitCode: 0,
     };
   }
   async screenshot(): Promise<never> {
     throw new Error('unused');
   }
   async click(): Promise<void> {
     throw new Error('unused');
   }
   async type(): Promise<void> {
     throw new Error('unused');
   }
   async pressKey(): Promise<void> {
     throw new Error('unused');
   }
   async scroll(): Promise<void> {
     throw new Error('unused');
   }
   async navigate(): Promise<never> {
     throw new Error('unused');
   }
   async readFile(): Promise<never> {
     throw new Error('unused');
   }
   async writeFile(): Promise<never> {
     throw new Error('unused');
   }
   async environment(): Promise<ComputerEnvironment> {
     return { os: 'Linux', platform: 'linux', user: 'u', home: '/home/u', workingDirectory: '/work', pathStyle: 'posix', kind: 'sandbox' };
   }
 }
 
 function agentDoc(id: string, owner: string): Agent & { ownerId: string } {
   return { id, ownerId: owner, createdBy: owner, name: 'Agent ' + id, handle: id, avatar: {shape:'circle',color:1,eyes:'happy'}, title:'QA',status:'idle',section:'Agents',pinned:false,lastActivity:'idle',unreadCount:0,model:{planner:{provider:'fixture',model:'fixture'},computer:{provider:'fixture',model:'fixture'},fast:{provider:'fixture',model:'fixture'}},channels:[],macAccess: false,skillIds:[],pluginIds:[],sharing:{publishedToTeam:false},createdAt:NOW,updatedAt:NOW };
 }
 
 function conversationDoc(id: string, agents: string[], members: string[]): Conversation {
   return { id, kind: 'direct', agentIds: agents, memberIds: members, unreadCount: 0, lastItemAt: NOW, createdAt: NOW };
 }
 
 async function seed(store: Store): Promise<void> {
   await store.put('agents', agentDoc('agent-1', OWNER));
   await store.put('conversations', conversationDoc('conv-1', ['agent-1'], [OWNER]));
   await store.put('conversations', conversationDoc('conv-other', ['agent-1'], [OWNER]));
 }
 
 function ctxFor(store: Store, enqueuer: Enqueuer, overrides: Partial<ToolContext> = {}): ToolContext {
   const wake: WakeEvent = {
     id: 'wke_1',
     ownerId: OWNER,
     agentId: 'agent-1',
     sessionKey: 'agent-1:conv-1',
     conversationId: 'conv-1',
     kind: 'user_message',
     origin: { type: 'user', id: OWNER },
     trusted: true,
     priority: 'user',
     payload: {},
     at: NOW,
     status: 'accepted',
   };
   return {
     ownerId: OWNER,
     agentId: 'agent-1',
     conversationId: 'conv-1',
     runId: 'run-1',
     store,
     blobs: createMemoryBlobStore(),
     enqueuer,
     wake,
     step: async (name, fn) => fn(),
     signal: new AbortController().signal,
     ...overrides,
   };
 }
 
 function textOf(result: ToolResult): string {
   return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
 }
 
 function detailString(result: ToolResult, key: string): string | undefined {
   const details: unknown = result.details;
   if (typeof details !== 'object' || details === null) return undefined;
   const value: unknown = Reflect.get(details, key);
   return typeof value === 'string' ? value : undefined;
 }
 
 function detailNumber(result: ToolResult, key: string): number | undefined {
   const details: unknown = result.details;
   if (typeof details !== 'object' || details === null) return undefined;
   const value: unknown = Reflect.get(details, key);
   return typeof value === 'number' ? value : undefined;
 }
 
 describe('send_file', () => {
   let store: Store;
   let enqueuer: StubEnqueuer;
   let computer: FakeComputer;
 
   beforeEach(async () => {
     store = createMemoryStore();
     enqueuer = new StubEnqueuer();
     computer = new FakeComputer();
     await seed(store);
   });
 
   function tool() {
     return createSendFileTool({
       store,
       computer: () => computer,
       environment: async () => ({ os: 'Linux', platform: 'linux', user: 'u', home: '/home/u', workingDirectory: '/work', pathStyle: 'posix', kind: 'sandbox' }),
     });
   }
 
 
   it('saves real binary bytes with matching sha and keeps bytes out of the model result', async () => {
     const bytes = Buffer.from([0, 1, 2, 250, 255, 72, 101, 108, 108, 111]);
     computer.files.set("/work/it's.bin", bytes);
     const ctx = ctxFor(store, enqueuer);
     const result = await tool().execute({ path: "/work/it's.bin", mimeType: 'application/octet-stream' }, ctx);
     expect(result.isError).not.toBe(true);
     expect(textOf(result)).toContain(String(bytes.length) + ' bytes');
     const libraryId = detailString(result, 'libraryId');
     expect(typeof libraryId).toBe('string');
     if (libraryId === undefined) throw new Error('missing libraryId');
     const expectedSha = createHash('sha256').update(bytes).digest('hex');
     expect(detailString(result, 'sha256')).toBe(expectedSha);
     expect(detailNumber(result, 'sizeBytes')).toBe(bytes.length);
     const scoped = store.forOwner?.(OWNER);
     if (!scoped) throw new Error('missing owner scope');
     const saved: unknown = await scoped.get('library', libraryId);
     if (typeof saved !== 'object' || saved === null) throw new Error('library row missing');
     // The row names the bytes; the bytes themselves are in the blob store, never in the document.
     expect(Reflect.get(saved, 'contentBase64')).toBeUndefined();
     expect(Reflect.get(saved, 'blobKey')).toBe('blobs/' + expectedSha);
     expect(await ctx.blobs.get('blobs/' + expectedSha)).toEqual(bytes);
     expect(Reflect.get(saved, 'sha256')).toBe(expectedSha);
     expect(Reflect.get(saved, 'sizeBytes')).toBe(bytes.length);
     expect(Reflect.get(saved, 'previewUrl')).toBeUndefined();
     const items = await scoped.list('items', { where: { conversationId: 'conv-1' } });
     const artifact = items.items.find(item => item.type === 'artifact');
     expect(artifact).toBeDefined();
     const asText = JSON.stringify(result) + JSON.stringify(artifact);
     expect(asText).not.toContain(bytes.toString('base64').slice(0, 20));
   });
 
   it('in a platform chat the file also goes into that chat through the port; the words say so', async () => {
     computer.files.set('/work/notes.txt', Buffer.from('hello'));
     const sent: Array<{ origin: { kind: string; chatId: string }; file: { name: string; bytes: Uint8Array } }> = [];
     const channels = {
       react: async () => ({ status: 'unsupported' as const }),
       history: async () => ({ status: 'unsupported' as const }),
       sendFile: async (input: { origin: { kind: string; chatId: string }; file: { name: string; bytes: Uint8Array } }) => {
         sent.push(input);
         return { status: 'ok' as const, value: {} };
       },
     };
     const wake = { ...ctxFor(store, enqueuer).wake, payload: { channelKind: 'telegram', channelId: 'bot', chatId: '1', threadId: '1', externalMessageId: '1:7', text: 'send it' } };
     const result = await createSendFileTool({
       store,
       computer: () => computer,
       environment: async () => ({ os: 'Linux', platform: 'linux', user: 'u', home: '/home/u', workingDirectory: '/work', pathStyle: 'posix', kind: 'sandbox' }),
       channels,
     }).execute({ path: '/work/notes.txt' }, ctxFor(store, enqueuer, { wake }));
     expect(result.isError).not.toBe(true);
     expect(textOf(result)).toContain('It is also posted in this chat.');
     expect(sent.map((input) => [input.origin.kind, input.origin.chatId, input.file.name, Buffer.from(input.file.bytes).toString()])).toEqual([['telegram', '1', 'notes.txt', 'hello']]);
   });

   it('delivers an empty file', async () => {
     computer.files.set('/work/empty.txt', Buffer.alloc(0));
     const result = await tool().execute({ path: '/work/empty.txt' }, ctxFor(store, enqueuer));
     expect(result.isError).not.toBe(true);
     expect(detailNumber(result, 'sizeBytes')).toBe(0);
     expect(textOf(result)).toContain('0 bytes');
   });
 
   it('resolves a relative path against the run environment', async () => {
     const bytes = Buffer.from('hello-relative');
     computer.files.set('/work/notes/report.md', bytes);
     const result = await tool().execute({ path: 'notes/report.md' }, ctxFor(store, enqueuer));
     expect(result.isError).not.toBe(true);
     expect(detailString(result, 'name')).toBe('report.md');
   });
 
   it('rejects a foreign owner before any sandbox read', async () => {
     computer.files.set('/work/secret.bin', Buffer.from('x'));
     const result = await tool().execute(
       { path: '/work/secret.bin' },
       ctxFor(store, enqueuer, { ownerId: OTHER_OWNER }),
     );
     expect(result.isError).toBe(true);
     expect(computer.calls).toHaveLength(0);
     const scoped = store.forOwner?.(OWNER);
     if (!scoped) throw new Error('missing owner scope');
     expect((await scoped.list('library', {})).items).toHaveLength(0);
   });
 

   it('rejects files over the 10MiB limit without saving', async () => {
     computer.files.set('/work/big.bin', Buffer.alloc(LIMIT + 1));
     const result = await tool().execute({ path: '/work/big.bin' }, ctxFor(store, enqueuer));
     expect(result.isError).toBe(true);
     expect(textOf(result)).toContain('10MiB');
     const scoped = store.forOwner?.(OWNER);
     if (!scoped) throw new Error('missing owner scope');
     expect((await scoped.list('library', {})).items).toHaveLength(0);
   });
 
   it('fails a tampered hash without saving', async () => {
     computer.files.set('/work/tampered.bin', Buffer.from('real-bytes'));
     computer.tamperSha = true;
     const result = await tool().execute({ path: '/work/tampered.bin' }, ctxFor(store, enqueuer));
     expect(result.isError).toBe(true);
     expect(textOf(result)).toContain('integrity');
   });
 
   it('rejects invalid paths before any sandbox read', async () => {
     const bad = await tool().execute({ path: '   ' }, ctxFor(store, enqueuer));
     expect(bad.isError).toBe(true);
     const nul = await tool().execute({ path: 'a\0b' }, ctxFor(store, enqueuer));
     expect(nul.isError).toBe(true);
     const traversal = await tool().execute({ path: '/work/a.bin', name: '..\\evil' }, ctxFor(store, enqueuer));
     expect(traversal.isError).toBe(true);
     await expect(tool().execute({ path: '' }, ctxFor(store, enqueuer))).rejects.toThrow();
     expect(computer.calls).toHaveLength(0);
   });
 
   it('fails closed when the sandbox is missing', async () => {
     const missing = createSendFileTool({ store });
     const result = await missing.execute({ path: '/work/a.bin' }, ctxFor(store, enqueuer));
     expect(result.isError).toBe(true);
   });
 });
 
 describe('send_message file kinds', () => {
   let store: Store;
   let enqueuer: StubEnqueuer;
 
   beforeEach(async () => {
     store = createMemoryStore();
     enqueuer = new StubEnqueuer();
     await seed(store);
   });
 
   it('directs attachment posts to send_file as an explicit error', async () => {
     const send = createSendMessageTool({ store, enqueuer });
     const result = await send.execute({ kind: 'attachment', text: 'see file' }, ctxFor(store, enqueuer));
     expect(result.isError).toBe(true);
     expect(textOf(result)).toContain('send_file');
   });
 
   it('rejects secret_request explicitly', async () => {
     const send = createSendMessageTool({ store, enqueuer });
     const result = await send.execute({ kind: 'secret_request', text: 'code?' }, ctxFor(store, enqueuer));
     expect(result.isError).toBe(true);
   });
 });
