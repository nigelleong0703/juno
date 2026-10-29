/** The server's evaluation reports folder is refused by the agent's file tools on every target, before any computer is asked. */
import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComputerClient } from '../../../../ports/computer/index.js';
import type { ToolContext, ToolResult } from '../../../../contracts/index.js';
import { refuseServerReports } from '../homeGuard.js';
import { createFileEditTool } from '../codingEdit.js';
import { createFileReadTool, createFileWriteTool } from '../computerFiles.js';

const REPORTS = '/srv/juno-eval/reports';
const saved = process.env['EVAL_REPORTS_DIR'];

beforeEach(() => {
  process.env['EVAL_REPORTS_DIR'] = REPORTS;
});

afterEach(() => {
  if (saved === undefined) delete process.env['EVAL_REPORTS_DIR'];
  else process.env['EVAL_REPORTS_DIR'] = saved;
});

function fakeClient(): { client: ComputerClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    readFile: async (_agentId: string, path: string) => {
      calls.push(`read ${path}`);
      return { content: 'hello\n', bytes: 6, path };
    },
    writeFile: async (_agentId: string, input: { path: string; content: string }) => {
      calls.push(`write ${input.path}`);
      return { path: input.path, bytes: input.content.length };
    },
  } as unknown as ComputerClient;
  return { client, calls };
}

const ctx = { agentId: 'agent-1', signal: new AbortController().signal } as unknown as ToolContext;

const refusedWith = (result: ToolResult): boolean => result.isError === true && (result.details?.['code'] as string | undefined) === 'server_reports';

describe('refuseServerReports', () => {
  it('refuses the folder and everything inside it, after normalising ".." parts', () => {
    expect(refuseServerReports(REPORTS)).toBeDefined();
    expect(refuseServerReports(`${REPORTS}/weekly/weekly-2026-10-26.json`)).toBeDefined();
    expect(refuseServerReports('/srv/juno-eval/other/../reports/weekly/x.md')).toBeDefined();
  });

  it('leaves a sibling folder that only shares the name prefix, and paths elsewhere, alone', () => {
    expect(refuseServerReports('/srv/juno-eval/reports-old/x.md')).toBeUndefined();
    expect(refuseServerReports('/srv/juno-eval/notes.md')).toBeUndefined();
    expect(refuseServerReports('/juno/memory/MEMORY.md')).toBeUndefined();
  });

  it('expands ~/ to the server user home, so a Mac path to the same folder is refused too', () => {
    process.env['EVAL_REPORTS_DIR'] = `${homedir()}/.juno-server/eval-reports`;
    expect(refuseServerReports('~/.juno-server/eval-reports/evalbank/x.log')).toBeDefined();
    expect(refuseServerReports('~/Documents/notes.md')).toBeUndefined();
  });
});

describe('the file tools', () => {
  it('files.read refuses the folder on the Mac target too, and never asks the computer for it', async () => {
    const { client, calls } = fakeClient();
    const tool = createFileReadTool({ computer: () => client });
    const result = await tool.execute({ path: `${REPORTS}/weekly/weekly-2026-10-26.md`, on: 'mac' }, ctx);
    expect(refusedWith(result)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('files.read and files.edit refuse the folder in the sandbox as well, and files.write too', async () => {
    const { client, calls } = fakeClient();
    const read = createFileReadTool({ computer: () => client });
    const edit = createFileEditTool({ computer: () => client });
    const write = createFileWriteTool({ computer: () => client });
    expect(refusedWith(await read.execute({ path: `${REPORTS}/x.json` }, ctx))).toBe(true);
    expect(refusedWith(await edit.execute({ path: `${REPORTS}/x.json`, oldText: 'a', newText: 'b' }, ctx))).toBe(true);
    expect(refusedWith(await write.execute({ path: `${REPORTS}/x.json`, content: 'x' }, ctx))).toBe(true);
    expect(calls).toEqual([]);
  });

  it('files.read still reads a sibling folder on the Mac', async () => {
    const { client, calls } = fakeClient();
    const tool = createFileReadTool({ computer: () => client });
    const result = await tool.execute({ path: '/srv/juno-eval/reports-old/x.md', on: 'mac' }, ctx);
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(['read /srv/juno-eval/reports-old/x.md']);
  });
});
