/**
 * LIVE artifact previews (BACKEND 5.11) against a real throwaway container of the local desktop image: the production
 * `buildPreviews` (LibreOffice to PDF, then pdftoppm when the image has it) driven through the real local provider as an
 * agent's own Linux user. Skipped unless LIVE_DOCKER=1 (needs Docker and the image `juno-desktop:local`). It starts its
 * own container and removes it afterwards; it never touches another one.
 *
 *   LIVE_DOCKER=1 pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/artifact-preview.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import type { ComputerClient } from 'juno-agent/computer';
import { buildPreviews } from 'juno-agent/modules/tools/tools/artifactPreview';
import { parseEnvironment } from './environment.js';
import { liveImage, startLiveLink, type LiveLink } from './live-link.js';
import { createLocalProvider } from './local.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;
const AGENT = 'agent-live-preview';
const signal = () => AbortSignal.timeout(240_000);

live('artifact previews on a real container', () => {
  let link: LiveLink;
  let provider: ReturnType<typeof createLocalProvider>;
  let binding: E2bBinding;

  const sh = async (command: string, timeoutMs = 120_000) => {
    const result = await provider.act(binding, AGENT, 1, { kind: 'shell', input: { command, timeoutMs } }, signal());
    if (!result.shell) throw new Error('no shell result');
    return result.shell;
  };
  // Only runShell is used by the preview code; everything else of the client is the tools' business.
  const computer = { runShell: (_agent: string, input: { command: string; timeoutMs?: number }) => sh(input.command, input.timeoutMs) } as unknown as ComputerClient;
  const environment = async () => parseEnvironment({ os: 'Debian', platform: 'linux', user: 'agent', home: '/home/agent', workingDirectory: '/workspace', pathStyle: 'posix', kind: 'sandbox' });
  const ctx = { agentId: AGENT, runId: 'run-live', signal: new AbortController().signal };

  beforeAll(async () => {
    link = await startLiveLink();
    provider = createLocalProvider({ ownerId: 'live-artifact-preview', image: liveImage(), hub: link.hub, linkUrl: link.linkUrl });
    binding = await provider.create({ template: liveImage(), resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 }, signal());
    await provider.ensureScreen(binding, { agentId: AGENT, displayNo: 1, resolution: '1024x768', controlPassword: 'ctl', viewPassword: 'view' }, signal());
  }, 300_000);

  afterAll(() => {
    try {
      if (binding) execFileSync('docker', ['rm', '-f', binding.sandboxId], { stdio: 'ignore' });
    } finally {
      provider.dispose();
      link.close();
    }
  }, 60_000);

  it('turns a docx into a PDF preview as the agent user, and says plainly when pdftoppm is missing', async () => {
    const made = await sh(
      'cd /workspace && echo "<html><body><h1>Quarterly report</h1><p>Hello world</p></body></html>" > live.html && ' +
        'soffice --headless -env:UserInstallation=file:///tmp/lo-live --infilter="HTML (StarWriter)" --convert-to docx:"MS Word 2007 XML" --outdir /workspace /workspace/live.html >/dev/null 2>&1; ls -l /workspace/live.docx',
    );
    expect(made.exitCode).toBe(0);
    const hasPdftoppm = (await sh('command -v pdftoppm')).exitCode === 0;

    const previews = await buildPreviews({ computer: () => computer, environment }, ctx, '/workspace/live.docx', 'live.docx');
    expect(previews.preview).toBeDefined();
    const pdf = previews.preview?.bytes ?? Buffer.alloc(0);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(previews.preview?.sizeBytes).toBeGreaterThan(1000);
    if (hasPdftoppm) {
      const png = previews.thumbnail?.bytes ?? Buffer.alloc(0);
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
      expect(previews.notes).toEqual([]);
    } else {
      expect(previews.thumbnail).toBeUndefined();
      expect(previews.notes.join(' ')).toContain('pdftoppm is not installed');
    }
    // The temporary directory is gone.
    expect((await sh('ls -d /tmp/tmp.* 2>/dev/null | wc -l')).stdout.trim()).toBe('0');
  }, 300_000);

  it('screenshots an html page with the image chromium as a PNG, and leaves no profile behind', async () => {
    const made = await sh('cd /workspace && echo "<!doctype html><title>Trip</title><h1>Trip plan</h1><p>Day 1: Shinjuku</p>" > live-page.html && ls -l live-page.html');
    expect(made.exitCode).toBe(0);
    const previews = await buildPreviews({ computer: () => computer, environment }, ctx, '/workspace/live-page.html', 'live-page.html');
    expect(previews.notes).toEqual([]);
    expect(previews.preview).toBeUndefined();
    const png = previews.thumbnail?.bytes ?? Buffer.alloc(0);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(previews.thumbnail?.sizeBytes).toBeGreaterThan(1000);
    // IHDR: width and height are big-endian uint32 at bytes 16 and 20. The page is laid out in 1200x900 and written at half size.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([600, 450]);
    expect((await sh('ls -d /tmp/tmp.* 2>/dev/null | wc -l')).stdout.trim()).toBe('0');
  }, 300_000);

  it('a PDF alone gets no converted preview, and an Office file LibreOffice cannot load only loses its preview', async () => {
    const pdfOnly = await buildPreviews({ computer: () => computer, environment }, ctx, '/workspace/live.docx', 'live.pdf');
    expect(pdfOnly.preview).toBeUndefined();
    // LibreOffice happily opens a text file named .docx, so "broken" here is a file it cannot load at all.
    const broken = await buildPreviews({ computer: () => computer, environment }, ctx, '/workspace/missing.docx', 'missing.docx');
    expect(broken.preview).toBeUndefined();
    expect(broken.notes.join(' ')).toContain('LibreOffice could not convert');
  }, 300_000);
});
