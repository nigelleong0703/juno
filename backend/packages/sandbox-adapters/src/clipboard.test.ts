/**
 * The computer clipboard side channel (M-CLIP) against a scripted computer: the agent's files, the X clipboard selection
 * and the xclip/stat/cp/ffmpeg commands the module writes, read back the way a shell would run them. No real X server.
 */
import { describe, expect, it } from 'vitest';
import { posix } from 'node:path';
import { copyFromComputer, downloadsDir, firstFilePath, pastedImagesDir, pasteToComputer, safeFileName } from './clipboard.js';
import { agentHome } from './isolation-user.js';
import type { CommandResult, SandboxRuntime } from './runtime.js';

const AGENT = 'agent-clip-test';
const MAX = 10 * 1024 * 1024;
const bytesOf = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** One computer: what the agent's shell sees (files, the X selection, staging files) and the commands it was asked to run. */
function computer(selection: Record<string, Uint8Array> = {}, files: Record<string, Uint8Array> = {}) {
  const sel = new Map(Object.entries(selection));
  const fs = new Map(Object.entries(files));
  const stage = new Map<string, Uint8Array>();
  const commands: string[] = [];

  const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
  const fail = (): CommandResult => ({ stdout: '', stderr: '', exitCode: 1 });
  const quoted = (command: string, pattern: RegExp) => pattern.exec(command)?.[1];

  /** The agent's shell: the pieces this module writes, nothing else. */
  function agentRun(command: string): CommandResult {
    commands.push(command);
    // saveFiles: reserve a free name per file, print the paths.
    if (command.includes('reserve() {')) {
      const dir = quoted(command, /D='([^']*)'/) ?? '';
      const out: string[] = [];
      for (const match of command.matchAll(/^reserve '([^']*)' '([^']*)'$/gm)) {
        const stem = match[1] ?? '';
        const ext = match[2] ?? '';
        let path = `${dir}/${stem}${ext}`;
        for (let n = 2; fs.has(path); n += 1) path = `${dir}/${stem} (${n})${ext}`;
        fs.set(path, new Uint8Array());
        out.push(path);
      }
      return ok(out.join('\n') + '\n');
    }
    // imageToClipboard: convert a JPEG first (ffmpeg, then rm of the source), then own the selection with the PNG.
    if (command.includes('-t image/png -i ')) {
      if (command.includes('ffmpeg')) {
        const source = /ffmpeg -y -loglevel error -i '([^']+)'/.exec(command)?.[1] ?? '';
        const target = /-loglevel error -i '[^']+' '([^']+)'/.exec(command)?.[1] ?? '';
        if (!fs.has(source)) return fail();
        fs.set(target, PNG);
        fs.delete(source);
      }
      const png = quoted(command, /-t image\/png -i '([^']+)'/) ?? '';
      const data = fs.get(png);
      if (data === undefined) return fail();
      sel.set('image/png', data);
      return ok();
    }
    // TARGETS: the offered atoms, or nothing when no owner exists.
    if (command.includes('-o -t TARGETS')) {
      return sel.size === 0 ? fail() : ok([...sel.keys()].join('\n') + '\n');
    }
    // A stat of a staging file: the pull before it wrote the file (xclip to stage, or cp of a copied file).
    const statStage = quoted(command, /stat -c %s -- '([^']+)'/);
    if (statStage !== undefined) {
      if (command.includes(' cp -- ')) {
        const from = quoted(command, /\[ -f '([^']+)' \]/) ?? '';
        const data = fs.get(from);
        if (data === undefined) return fail();
        stage.set(statStage, data);
      } else {
        const target = /-t (?:'([^']*)'|(\S+)) -o/.exec(command);
        const name = target?.[1] ?? target?.[2] ?? '';
        const data = sel.get(name);
        if (data === undefined) return fail();
        stage.set(statStage, data);
      }
      const data = stage.get(statStage);
      return data === undefined ? fail() : ok(String(data.byteLength) + '\n');
    }
    return fail();
  }

  const agent: SandboxRuntime = {
    run: async (command) => agentRun(command),
    async readText() {
      throw new Error('not used');
    },
    async readBytes() {
      throw new Error('the agent does not read staging files');
    },
    async writeText() {},
    async writeBytes(path, content) {
      fs.set(path, content);
    },
  };
  // Root reads staging files and removes them; it is not the agent's shell.
  const root: SandboxRuntime = {
    async run(command) {
      for (const match of command.matchAll(/rm -f -- '([^']+)'/g)) stage.delete(match[1] ?? '');
      return ok();
    },
    async readText() {
      throw new Error('not used');
    },
    async readBytes(path) {
      const data = stage.get(path) ?? fs.get(path);
      if (data === undefined) throw new Error(`no such file ${path}`);
      return data;
    },
    async writeText() {},
    async writeBytes() {},
  };
  return { agent, root, sel, fs, stage, commands };
}

describe('copyFromComputer (what the computer copied, in order: image, text, a copied file)', () => {
  it('returns the PNG when the clipboard offers image/png, even with text beside it', async () => {
    const { agent, root, stage } = computer({ 'image/png': PNG, UTF8_STRING: bytesOf('caption') });
    const copied = await copyFromComputer(root, agent, 1, MAX);
    expect(copied).toEqual({ kind: 'image', bytes: PNG });
    expect(stage.size).toBe(0);
  });

  it('returns the text when there is text and no image', async () => {
    const { agent, root } = computer({ UTF8_STRING: bytesOf('héllo 世界') });
    expect(await copyFromComputer(root, agent, 1, MAX)).toEqual({ kind: 'text', text: 'héllo 世界' });
  });

  it('returns the first file of a copied uri-list with its bytes and name', async () => {
    const path = `${agentHome(AGENT)}/Documents/My Report.pdf`;
    const uriList = `# copied from the file manager\r\nfile://${path.replace(/ /g, '%20')}\r\nfile:///other.txt\r\n`;
    const { agent, root } = computer({ 'text/uri-list': bytesOf(uriList) }, { [path]: bytesOf('%PDF-1.4') });
    expect(await copyFromComputer(root, agent, 1, MAX)).toEqual({ kind: 'file', name: 'My Report.pdf', bytes: bytesOf('%PDF-1.4') });
  });

  it('answers empty when nothing is selected (no owner of the clipboard)', async () => {
    const { agent, root } = computer();
    expect(await copyFromComputer(root, agent, 1, MAX)).toEqual({ kind: 'empty' });
  });

  it('answers empty when the copied file is not there any more', async () => {
    const { agent, root } = computer({ 'text/uri-list': bytesOf('file:///home/nobody/gone.pdf\n') });
    expect(await copyFromComputer(root, agent, 1, MAX)).toEqual({ kind: 'empty' });
  });

  it('reports the size, not the bytes, of an item over the limit', async () => {
    const { agent, root } = computer({ 'image/png': PNG });
    expect(await copyFromComputer(root, agent, 1, 4)).toEqual({ kind: 'tooLarge', sizeBytes: PNG.byteLength });
  });
});

describe('pasteToComputer (device to computer)', () => {
  it('writes a PNG into Pictures/Pasted and puts it on the X clipboard', async () => {
    const { agent, sel } = computer();
    const result = await pasteToComputer(agent, AGENT, 1, { kind: 'image', mimeType: 'image/png', bytes: PNG });
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') return;
    expect(posix.dirname(result.path)).toBe('Pictures/Pasted');
    expect(result.path.endsWith('.png')).toBe(true);
    expect(sel.get('image/png')).toEqual(PNG);
  });

  it('converts a JPEG to PNG before it goes on the clipboard, and keeps no JPEG', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
    const { agent, sel, fs, commands } = computer();
    const result = await pasteToComputer(agent, AGENT, 1, { kind: 'image', mimeType: 'image/jpeg', bytes: jpeg });
    expect(result.kind).toBe('image');
    expect(commands.some((command) => command.includes('ffmpeg'))).toBe(true);
    expect([...fs.keys()].some((path) => path.endsWith('.jpg'))).toBe(false);
    expect(sel.get('image/png')).toEqual(PNG);
  });

  it('saves files to Downloads and gives a second file with the same name a free name', async () => {
    const { agent, fs } = computer();
    const result = await pasteToComputer(agent, AGENT, 1, {
      kind: 'files',
      files: [
        { name: 'notes.txt', bytes: bytesOf('one') },
        { name: 'notes.txt', bytes: bytesOf('two') },
      ],
    });
    expect(result).toEqual({
      kind: 'files',
      saved: [
        { name: 'notes.txt', path: 'Downloads/notes.txt' },
        { name: 'notes (2).txt', path: 'Downloads/notes (2).txt' },
      ],
    });
    expect(fs.get(`${downloadsDir(AGENT)}/notes.txt`)).toEqual(bytesOf('one'));
    expect(fs.get(`${downloadsDir(AGENT)}/notes (2).txt`)).toEqual(bytesOf('two'));
  });

  it('never saves outside Downloads, whatever the name says', async () => {
    const { agent, fs } = computer();
    const result = await pasteToComputer(agent, AGENT, 1, { kind: 'files', files: [{ name: '../../etc/passwd', bytes: bytesOf('x') }] });
    expect(result).toEqual({ kind: 'files', saved: [{ name: 'passwd', path: 'Downloads/passwd' }] });
    expect(fs.has(`${downloadsDir(AGENT)}/passwd`)).toBe(true);
  });

  it('lays the images under the agent home', () => {
    expect(pastedImagesDir(AGENT)).toBe(`${agentHome(AGENT)}/Pictures/Pasted`);
  });
});

describe('name and path helpers', () => {
  it('keeps the last path part and drops control characters and leading dots', () => {
    expect(safeFileName('a/b/c.txt')).toBe('c.txt');
    expect(safeFileName('..secret\u0007.env')).toBe('secret.env');
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName('')).toBe('file');
  });

  it('takes the first local file of a uri-list, decoded, and skips comments and other schemes', () => {
    expect(firstFilePath('# c\nhttps://x.example/a\nfile:///home/u/a%20b.txt\nfile:///other')).toBe('/home/u/a b.txt');
    expect(firstFilePath('https://x.example/only-web')).toBeNull();
  });
});
