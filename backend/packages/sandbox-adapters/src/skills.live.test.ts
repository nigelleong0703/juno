/**
 * LIVE platform skills (BACKEND §5.11) on a real throwaway container of the local desktop image: the image predates the
 * skills, so the test installs what the template installs (apt packages, the bundle from prepare_assets.py, the venv from
 * the template's own pip command) and then runs every skill's CLI as an agent user through the isolation layer's shell.
 * Skipped unless LIVE_DOCKER=1 (needs Docker, `juno-desktop:local` and network for apt/pip). It starts its own container
 * and removes it afterwards; it never touches another one.
 *
 *   LIVE_DOCKER=1 pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/skills.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import { createSandboxHome } from './home.js';
import { installPackages } from './isolation.js';
import { liveImage, startLiveLink, type LiveLink } from './live-link.js';
import { createLocalProvider } from './local.js';
import { shq } from './screen-boot.js';
import type { ScreenRequest } from './types.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;

const AGENT = 'agent-skills-live';
const IMAGE_DIR = join(import.meta.dirname, '..', '..', 'sandbox-image');
const signal = () => AbortSignal.timeout(300_000);
const S = '/opt/juno/skills';
const PY = '/opt/juno/venv/bin/python';

/** The template's own venv/pip command, read from its source so the test cannot drift from the image recipe. */
function templateVenvCommand(): string {
  const source = readFileSync(join(IMAGE_DIR, 'template_debian.py'), 'utf8');
  const match = /"(python3 -m venv [^"]*)"\s*"([^"]*requirements\.txt)"/.exec(source);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error('template_debian.py has no skills venv command');
  return match[1] + match[2];
}

const request: ScreenRequest = { agentId: AGENT, displayNo: 1, resolution: '1024x768', controlPassword: 'ctl-1', viewPassword: 'view-1' };

live('platform skills on a real container', () => {
  let link: LiveLink;
  let provider: ReturnType<typeof createLocalProvider>;
  let binding: E2bBinding;
  let scratch = '';

  /** Runs as the agent's own Linux user (cwd /workspace); throws with the output when the command fails. */
  const sh = async (command: string): Promise<string> => {
    const result = await provider.act(binding, AGENT, 1, { kind: 'shell', input: { command, timeoutMs: 280_000 } }, signal());
    const out = result.shell;
    if (!out) throw new Error('no shell result');
    if (out.exitCode !== 0) throw new Error(`exit ${String(out.exitCode)}: ${command}\n${out.stdout}\n${out.stderr}`);
    return out.stdout;
  };
  /** A Python check in the skills venv, as the agent user; prints to stdout. */
  const py = (code: string) => sh(`${PY} - <<'PY'\n${code}\nPY`);
  const write = (path: string, content: string) => sh(`cat > ${shq(path)} <<'EOF'\n${content}\nEOF`);

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'skills-live-'));
    link = await startLiveLink();
    provider = createLocalProvider({ ownerId: 'live-skills-test', image: liveImage(), hub: link.hub, linkUrl: link.linkUrl });
    binding = await provider.create({ template: liveImage(), resolution: '1024x768', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 }, signal());
    await provider.ensureScreen(binding, request, signal());
    execFileSync('python3', [join(IMAGE_DIR, 'prepare_assets.py'), '--without-daemon', '--output', join(scratch, 'assets.tar')]);
    execFileSync('docker', ['cp', join(scratch, 'assets.tar'), binding.sandboxId + ':/tmp/assets.tar']);
    await provider.withRuntime(binding, signal(), async (runtime) => {
      await installPackages(runtime, ['python3-venv', 'pandoc']);
      const done = await runtime.run(`set -e; tar -xpf /tmp/assets.tar -C / && rm /tmp/assets.tar && ${templateVenvCommand()}`, { timeoutMs: 600_000 });
      if (done.exitCode !== 0) throw new Error(done.stdout + done.stderr);
    }, { user: 'root' });
  }, 900_000);

  afterAll(() => {
    try {
      if (binding) execFileSync('docker', ['rm', '-f', binding.sandboxId], { stdio: 'ignore' });
    } finally {
      provider.dispose();
      link.close();
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);

  it('runs as the agent user and sees every platform skill, read-only', async () => {
    expect((await sh('id -un')).trim()).toMatch(/^juno-/);
    const list = await sh(`head -n 4 ${S}/*/SKILL.md | grep -E '^(name|description):' | wc -l`);
    // Seven skills with a name and a description each (the spaces skill joined the six office ones in the Spaces batch).
    expect(Number(list.trim())).toBe(14);
    expect(await sh(`echo x >> ${S}/docx/SKILL.md 2>&1 || echo denied`)).toContain('denied');
    // The home snapshot (what the context's skills section is built from) lists them with name, description and path.
    const snapshot = await provider.withRuntime(binding, signal(), (runtime) => createSandboxHome(runtime).snapshot(AGENT), { user: 'root' });
    expect(snapshot.platformSkills?.map((skill) => skill.name).sort()).toEqual(['card', 'docx', 'huddle', 'markdown', 'pdf', 'pptx', 'spaces', 'xlsx']);
    expect(snapshot.platformSkills?.find((skill) => skill.name === 'pdf')).toEqual({ name: 'pdf', path: `${S}/pdf/SKILL.md`, description: expect.stringContaining('merge') });
  });

  it('docx: creates, edits and reopens a Word document', async () => {
    await write('/workspace/docx.json', JSON.stringify({ blocks: [
      { type: 'heading', text: 'Quarterly Report', level: 1 },
      { type: 'paragraph', text: 'Revenue grew in PLACEHOLDER.' },
      { type: 'bullets', items: ['alpha point', 'beta point'] },
      { type: 'table', rows: [['Region', 'Sales'], ['North', '120'], ['South', '95']] },
    ] }));
    await sh(`${S}/docx/docx_tool.py create /workspace/report.docx /workspace/docx.json`);
    expect(await sh(`${S}/docx/docx_tool.py replace /workspace/report.docx PLACEHOLDER Q3`)).toContain('replaced 1');
    const out = await py(`from docx import Document
d = Document('/workspace/report.docx')
print('PARAS', [p.text for p in d.paragraphs])
print('CELL', d.tables[0].cell(2, 1).text)`);
    expect(out).toContain('Quarterly Report');
    expect(out).toContain('Revenue grew in Q3.');
    expect(out).toContain('beta point');
    expect(out).toContain('CELL 95');
    expect(await sh(`${S}/docx/docx_tool.py text /workspace/report.docx`)).toContain('North\t120');
  }, 120_000);

  it('pptx: creates a deck that reopens with its slides and notes', async () => {
    await write('/workspace/pptx.json', JSON.stringify({ slides: [
      { layout: 'title', title: 'Launch Plan', subtitle: 'Autumn' },
      { title: 'Milestones', bullets: ['design done', 'beta shipped'], notes: 'say thanks' },
      { title: 'Budget', table: [['Item', 'Cost'], ['Ads', '300']] },
    ] }));
    await sh(`${S}/pptx/pptx_tool.py create /workspace/deck.pptx /workspace/pptx.json`);
    const out = await py(`from pptx import Presentation
p = Presentation('/workspace/deck.pptx')
print('SLIDES', len(p.slides))
print('T', [s.shapes.title.text for s in p.slides])
print('NOTES', p.slides[1].notes_slide.notes_text_frame.text)`);
    expect(out).toContain('SLIDES 3');
    expect(out).toContain("'Launch Plan', 'Milestones', 'Budget'");
    expect(out).toContain('NOTES say thanks');
    expect(await sh(`${S}/pptx/pptx_tool.py text /workspace/deck.pptx`)).toContain('beta shipped');
  }, 120_000);

  it('xlsx: creates formulas and formats, edits a cell and recalculates with LibreOffice', async () => {
    await write('/workspace/xlsx.json', JSON.stringify({ sheets: [
      { name: 'Sales', rows: [['Item', 'Qty', 'Price', 'Total'], ['Tea', 2, 3.5, '=B2*C2'], ['Cake', 4, 2.25, '=B3*C3'], ['Sum', '', '', '=SUM(D2:D3)']], formats: { C: '#,##0.00', D: '#,##0.00' } },
    ] }));
    await sh(`${S}/xlsx/xlsx_tool.py create /workspace/sales.xlsx /workspace/xlsx.json`);
    await sh(`${S}/xlsx/xlsx_tool.py set /workspace/sales.xlsx 'Sales!B2' 10`);
    const out = await py(`from openpyxl import load_workbook
ws = load_workbook('/workspace/sales.xlsx')['Sales']
print('D2', ws['D2'].value, 'B2', ws['B2'].value, 'FMT', ws['D2'].number_format, 'HDR', ws['A1'].font.b, 'FREEZE', ws.freeze_panes)`);
    expect(out).toContain('D2 =B2*C2 B2 10 FMT #,##0.00 HDR True FREEZE A2');
    const calc = await sh(`${S}/xlsx/xlsx_tool.py recalc /workspace/sales.xlsx`);
    expect(calc).toContain('D2\t35');
    expect(calc).toContain('D4\t44');
  }, 180_000);

  it('pdf: creates (with Chinese), reports pages, extracts text, merges, splits and selects pages', async () => {
    await write('/workspace/pdf.json', JSON.stringify({ blocks: [
      { type: 'heading', text: 'Handbook Alpha', level: 1 },
      { type: 'paragraph', text: '你好，世界 plain words here' },
      { type: 'pagebreak' },
      { type: 'heading', text: 'Second Page Beta', level: 2 },
      { type: 'table', rows: [['K', 'V'], ['one', '1']] },
    ] }));
    expect(await sh(`${S}/pdf/pdf_tool.py create /workspace/a.pdf /workspace/pdf.json`)).toContain('2 pages');
    const text = await sh(`${S}/pdf/pdf_tool.py text /workspace/a.pdf`);
    expect(text).toContain('Handbook Alpha');
    expect(text).toContain('你好，世界');
    expect(text).toContain('Second Page Beta');
    await write('/workspace/p.html', '<html><body><h1>Printed Gamma</h1></body></html>');
    expect(await sh(`${S}/pdf/pdf_tool.py html /workspace/p.html /workspace/b.pdf`)).toContain('1 pages');
    expect(await sh(`${S}/pdf/pdf_tool.py merge /workspace/m.pdf /workspace/a.pdf /workspace/b.pdf`)).toContain('3 pages');
    expect(await sh(`${S}/pdf/pdf_tool.py info /workspace/m.pdf`)).toContain('pages: 3');
    expect(await sh(`${S}/pdf/pdf_tool.py split /workspace/m.pdf /workspace/split && ls /workspace/split`)).toContain('page-003.pdf');
    expect(await sh(`${S}/pdf/pdf_tool.py pages /workspace/m.pdf 3,1 /workspace/sel.pdf && ${S}/pdf/pdf_tool.py text /workspace/sel.pdf`)).toMatch(/Printed Gamma[\s\S]*Handbook Alpha/);
  }, 240_000);

  it('uploads: a binary file lands in /juno/uploads (agents read, none write) and its PDF/DOCX text is extracted as root', async () => {
    await write('/workspace/up.json', JSON.stringify({ blocks: [{ type: 'heading', text: 'Resume Zeta', level: 1 }, { type: 'paragraph', text: 'Skills: welding 你好' }] }));
    await sh(`${S}/pdf/pdf_tool.py create /workspace/up.pdf /workspace/up.json && ${S}/docx/docx_tool.py create /workspace/up.docx /workspace/up.json`);
    await provider.withRuntime(binding, signal(), async (runtime) => {
      const home = createSandboxHome(runtime);
      for (const format of ['pdf', 'docx'] as const) {
        const bytes = await runtime.readBytes(`/workspace/up.${format}`);
        const path = `uploads/lib-up/My Resume.${format}`;
        expect(await home.put(path, bytes)).toMatchObject({ written: true });
        expect(await home.put(path, bytes)).toMatchObject({ written: false });
        const { text, truncated } = await home.extractText(path, format);
        expect(text).toContain('Resume Zeta');
        expect(text).toContain('welding 你好');
        expect(truncated).toBe(false);
      }
    }, { user: 'root' });
    expect(await sh("head -c 5 '/juno/uploads/lib-up/My Resume.pdf'")).toBe('%PDF-');
    expect(await sh("echo x >> '/juno/uploads/lib-up/My Resume.pdf' 2>&1 || echo denied")).toContain('denied');
    expect(await sh('touch /juno/uploads/lib-up/new 2>&1 || echo denied')).toContain('denied');
  }, 240_000);

  it('markdown: converts to docx, pdf and html', async () => {
    await write('/workspace/notes.md', '# Trip Notes\n\n## Packing\n\n- passport\n- 你好\n\n| Day | Plan |\n|---|---|\n| 1 | Museum |\n');
    await sh(`${S}/markdown/markdown_tool.py convert /workspace/notes.md /workspace/notes.docx`);
    await sh(`${S}/markdown/markdown_tool.py convert /workspace/notes.md /workspace/notes.pdf`);
    await sh(`${S}/markdown/markdown_tool.py convert /workspace/notes.md /workspace/notes.html`);
    const docx = await py(`from docx import Document
d = Document('/workspace/notes.docx')
print('H', [p.text for p in d.paragraphs if p.style.name.startswith('Heading')], 'CELL', d.tables[0].cell(1, 1).text)`);
    expect(docx).toContain("'Trip Notes', 'Packing'");
    expect(docx).toContain('CELL Museum');
    const pdf = await sh(`${S}/pdf/pdf_tool.py text /workspace/notes.pdf`);
    expect(pdf).toContain('Trip Notes');
    expect(pdf).toContain('你好');
    expect(await sh('cat /workspace/notes.html')).toContain('Museum');
  }, 180_000);

  it('card: renders a PNG at the requested size and an animated MP4 with a real duration', async () => {
    await write('/workspace/card.html', `<html><body style="margin:0;width:600px;height:800px;background:#fff"><div style="width:100px;height:100px;background:#e33;position:absolute;top:100px;animation:m 2s linear forwards"></div><h1 style="position:absolute;top:400px">Card Title 卡片</h1><style>@keyframes m{from{left:0}to{left:500px}}</style></body></html>`);
    expect(await sh(`${S}/card/card_tool.py png /workspace/card.html /workspace/card.png --width 600 --height 800`)).toContain('wrote');
    const png = await py(`import struct
b = open('/workspace/card.png', 'rb').read()
print('PNG', b[:8] == b'\\x89PNG\\r\\n\\x1a\\n', struct.unpack('>II', b[16:24]))`);
    expect(png).toContain('PNG True (600, 800)');
    await sh(`${S}/card/card_tool.py mp4 /workspace/card.html /workspace/card.mp4 --width 600 --height 800 --seconds 2 --fps 8`);
    const probe = (await sh('ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,nb_frames:format=duration -of default=nw=1 /workspace/card.mp4')).trim();
    expect(probe).toContain('codec_name=h264');
    expect(probe).toContain('width=600');
    expect(probe).toContain('height=800');
    expect(Number(/duration=([\d.]+)/.exec(probe)?.[1])).toBeGreaterThan(1);
    // The animation really advances: the first and the last frame differ.
    const diff = await sh(`cd /workspace && ffmpeg -loglevel error -y -i card.mp4 -vf "select=eq(n\\,0)" -frames:v 1 first.png && ffmpeg -loglevel error -y -i card.mp4 -vf "select=eq(n\\,15)" -frames:v 1 last.png && cmp -s first.png last.png && echo same || echo different`);
    expect(diff.trim()).toBe('different');
  }, 280_000);
});
