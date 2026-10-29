import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ComputerClient } from '../../../ports/computer/client.js';
import { parseEnvironment } from '../../../ports/computer/environment.js';
import type { ShellOutput } from '../../../ports/computer/types.js';
import { renderPageThumbnail } from '../tools/artifactPreview.js';

const PNG = Buffer.from('a page rendered to pixels');
const ctx = { agentId: 'agent-1', runId: 'run-1', signal: new AbortController().signal };

/** A computer that answers each shell command through `answer`, and records the commands it was given. */
function fakeComputer(answer: (command: string) => ShellOutput | undefined) {
  const commands: string[] = [];
  const client = {
    environment: async () => parseEnvironment({ os: 'Debian', platform: 'linux', user: 'agent', home: '/home/agent', workingDirectory: '/workspace', pathStyle: 'posix', kind: 'sandbox' }),
    runShell: async (_agent: string, input: { command: string }) => {
      commands.push(input.command);
      return answer(input.command) ?? { stdout: '', stderr: 'unexpected command', exitCode: 1 };
    },
  };
  return { computer: client as unknown as ComputerClient, commands };
}

/** The production file reader answers with the bytes of the file it is asked for, or "No such file". */
function reader(files: Map<string, Buffer>, command: string): ShellOutput | undefined {
  if (!command.startsWith("python3 -c '")) return undefined;
  const path = /'([^']*)'$/.exec(command)?.[1] ?? '';
  const bytes = files.get(path);
  if (bytes === undefined) return { stdout: '', stderr: 'FileNotFoundError: No such file or directory', exitCode: 1 };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { stdout: JSON.stringify({ contentBase64: bytes.toString('base64'), sizeBytes: bytes.length, sha256 }), stderr: '', exitCode: 0 };
}

describe('renderPageThumbnail', () => {
  it('screenshots the page in a one-shot profile that never takes the agent DevTools port, and keeps the PNG it wrote', async () => {
    const files = new Map<string, Buffer>();
    const { computer, commands } = fakeComputer((command) => {
      if (command === 'mktemp -d') return { stdout: '/tmp/thumb-dir\n', stderr: '', exitCode: 0 };
      if (command.includes("--screenshot='/tmp/thumb-dir/thumb.png'")) {
        files.set('/tmp/thumb-dir/thumb.png', PNG);
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return reader(files, command);
    });
    const result = await renderPageThumbnail({ computer: () => computer }, ctx, '/workspace/trip.html');
    expect(result.note).toBeUndefined();
    expect(result.thumbnail?.bytes.equals(PNG)).toBe(true);
    const shot = commands.find((command) => command.includes('--screenshot='));
    expect(shot).toContain('kill $C');
    expect(shot).toContain('--remote-debugging-port=0');
    expect(shot).toContain("--user-data-dir='/tmp/thumb-dir/browser'");
    expect(commands).toContain("rm -rf '/tmp/thumb-dir'");
  });

  it('says why there is no thumbnail when the image has no browser', async () => {
    const { computer } = fakeComputer((command) => {
      if (command === 'mktemp -d') return { stdout: '/tmp/thumb-dir\n', stderr: '', exitCode: 0 };
      if (command.includes('--screenshot=')) return { stdout: '', stderr: '', exitCode: 9 };
      return undefined;
    });
    const result = await renderPageThumbnail({ computer: () => computer }, ctx, '/workspace/trip.html');
    expect(result.thumbnail).toBeUndefined();
    expect(result.note).toBe('thumbnail skipped: no browser is installed in this computer');
  });

  it('keeps no thumbnail, and says so, when the browser runs but writes no file', async () => {
    const files = new Map<string, Buffer>();
    const { computer } = fakeComputer((command) => {
      if (command === 'mktemp -d') return { stdout: '/tmp/thumb-dir\n', stderr: '', exitCode: 0 };
      if (command.includes('--screenshot=')) return { stdout: '', stderr: '', exitCode: 1 };
      return reader(files, command);
    });
    const result = await renderPageThumbnail({ computer: () => computer }, ctx, '/workspace/trip.html');
    expect(result.thumbnail).toBeUndefined();
    expect(result.note).toBe('thumbnail unavailable: the browser could not render the page');
  });
});
