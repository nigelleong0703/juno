/** Shared scaffolding for the sandbox-bound coding tool tests: one recording fake ComputerClient. */

import { createMemoryBlobStore } from '../../../testing/blobs.js';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createMemoryStore } from '../../../testing/store.js';
import type { Enqueuer, Store, Tool, ToolContext, ToolResult, WakeEvent } from '../../../contracts/index.js';
import { wakeEventSchema } from '../../../contracts/index.js';
import {
  createToolRegistry,
  type ComputerClient,
  type ComputerEnvironment,
  type ComputerError,
  type FileContent,
  type FileWriteRequest,
  type FileWriteResult,
  type Screenshot,
  type ShellInput,
  type ShellOutput,
} from '../index.js';

export const hashOf = (content: string): string => 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');

/** Records every call so a test can prove the tools stay on the bound (agent-scoped) sandbox. */
export class SandboxFiles implements ComputerClient {
  readonly files = new Map<string, string>();
  readonly reads: Array<{ agentId: string; path: string }> = [];
  readonly writes: FileWriteRequest[] = [];
  readonly shellCalls: ShellInput[] = [];
  readonly agentIds: string[] = [];
  shell: ShellOutput = { stdout: '', stderr: '', exitCode: 0 };
  failWith: ComputerError | undefined;
  env: ComputerEnvironment = {
    os: 'FakeOS 0.0 fakearch', platform: 'fake', user: 'agent', home: '/home/agent',
    workingDirectory: '/workspace', pathStyle: 'posix', kind: 'sandbox',
  };

  async screenshot(): Promise<Screenshot> { return { data: '', mimeType: 'image/png', width: 1, height: 1, displayNo: 1 }; }
  async click(): Promise<void> {}
  async type(): Promise<void> {}
  async pressKey(): Promise<void> {}
  async scroll(): Promise<void> {}
  async navigate(): Promise<{ url: string }> { return { url: 'https://fake.invalid/' }; }
  async environment(): Promise<ComputerEnvironment> { return this.env; }

  async runShell(agentId: string, input: ShellInput): Promise<ShellOutput> {
    this.agentIds.push(agentId);
    this.shellCalls.push(input);
    return this.shell;
  }

  async readFile(agentId: string, path: string): Promise<FileContent> {
    this.agentIds.push(agentId);
    this.reads.push({ agentId, path });
    if (this.failWith) throw this.failWith;
    const content = this.files.get(path) ?? '';
    return { content, bytes: Buffer.byteLength(content, 'utf8') };
  }

  async writeFile(agentId: string, input: FileWriteRequest): Promise<FileWriteResult> {
    this.agentIds.push(agentId);
    this.writes.push(input);
    if (this.failWith) throw this.failWith;
    this.files.set(input.path, input.content);
    return { path: input.path, bytes: Buffer.byteLength(input.content, 'utf8') };
  }
}

/**
 * A fake whose `runShell` executes the generated command in a real `sh` under a temp directory, so a
 * test exercises the actual grep/find program (exit status, quoting, bounding) rather than a scripted
 * string. This is test scaffolding only; the tools themselves never spawn a host process.
 */
export class LocalShellFiles extends SandboxFiles {
  constructor(readonly root: string) {
    super();
    this.env = { ...this.env, workingDirectory: root };
  }

  override async runShell(agentId: string, input: ShellInput): Promise<ShellOutput> {
    this.agentIds.push(agentId);
    this.shellCalls.push(input);
    const result = spawnSync('sh', ['-c', input.command], { cwd: input.cwd ?? this.root, encoding: 'utf8' });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 };
  }
}

export class NoopEnqueuer implements Enqueuer {
  async enqueue(): Promise<{ accepted: boolean }> { return { accepted: true }; }
  async stopRun(): Promise<void> {}
  async resolveAwakeable(): Promise<void> {}
  async scheduleRoutine(): Promise<void> {}
}

const wake: WakeEvent = wakeEventSchema.parse({
  id: 'wk-1', ownerId: 'owner', agentId: 'agent-1', sessionKey: 'agent-1:conv-1', conversationId: 'conv-1',
  kind: 'user_message', origin: { type: 'user' }, trusted: true, priority: 'user', payload: {}, at: '2026-10-08T00:00:00.000Z',
});

export function toolCtx(store: Store): ToolContext {
  return {
    ownerId: 'owner', agentId: 'agent-1', conversationId: 'conv-1', runId: 'run-1', store, blobs: createMemoryBlobStore(),
    enqueuer: new NoopEnqueuer(), wake, step: async (_name, fn) => fn(), signal: new AbortController().signal,
  };
}

export function textOf(result: ToolResult): string {
  const block = result.content[0];
  return block !== undefined && block.type === 'text' ? block.text : '';
}

export async function build(client?: SandboxFiles) {
  const store = createMemoryStore();
  const registry = await createToolRegistry({
    store,
    enqueuer: new NoopEnqueuer(),
    ...(client ? { computer: () => client } : {}),
  });
  return { store, registry };
}

export function requireTool(registry: { get(name: string): Tool | undefined }, name: string): Tool {
  const tool = registry.get(name);
  if (tool === undefined) throw new Error(name + ' missing');
  return tool;
}
