/**
 * Previews for artifact_publish (BACKEND 5.11), made inside the agent's own computer as the agent's Linux user:
 * Office files become a PDF with LibreOffice, and a PDF (the file itself or the converted one) also gets a
 * first-page PNG when `pdftoppm` is installed. An HTML page gets a 600x450 screenshot (laid out in a 1200x900 window) from the image's Chromium
 * (`renderPageThumbnail`, shared with the thumbnail backfill in agentd). Nothing is installed at runtime: a missing tool or a failed
 * conversion only leaves the preview out, and the reason goes back to the model and into the step details.
 */
import { readSandboxFile, runSandboxShell, shellQuote, type DecodedFile, type SandboxCtx, type SandboxOpts } from './sandboxFile.js';

// Ten minutes: a local computer installs LibreOffice on the first conversion (a few minutes of download); later ones take seconds.
const CONVERT_TIMEOUT_MS = 600_000;
/** Exit code the thumbnail command uses for "pdftoppm is not installed". */
const NO_PDFTOPPM = 9;
/** Exit code the page screenshot uses for "no browser is installed". */
const NO_BROWSER = 9;
/** The page screenshot is cut off after this many seconds; a page that renders slower keeps no thumbnail. */
const SCREENSHOT_TIMEOUT_SECONDS = 15;
/**
 * The window a page is laid out in. The image has no ImageMagick or Pillow, so the PNG is not resized afterwards: Chromium renders it at
 * PAGE_THUMBNAIL_SCALE (--force-device-scale-factor), which gives a 600x450 PNG with the layout of a 1200x900 window.
 */
export const PAGE_THUMBNAIL_WIDTH = 1200;
export const PAGE_THUMBNAIL_HEIGHT = 900;
const PAGE_THUMBNAIL_SCALE = 0.5;

export const OFFICE_EXTENSIONS = ['docx', 'pptx', 'xlsx'];

export interface Previews {
  /** PDF of an Office file. */
  preview?: DecodedFile;
  /** First-page PNG of a PDF or Office file, or a screenshot of an HTML page. */
  thumbnail?: DecodedFile;
  /** Why a preview is missing, one line each. */
  notes: string[];
}

export function extensionOf(name: string): string {
  return name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
}

/** Which previews make sense for this file name: PDF and Office files get a thumbnail, Office files also a PDF, HTML pages a browser screenshot. */
export function previewPlan(name: string): { convert: boolean; thumbnail: boolean; page: boolean } {
  const ext = extensionOf(name);
  const convert = OFFICE_EXTENSIONS.includes(ext);
  const page = ext === 'html' || ext === 'htm';
  return { convert, thumbnail: convert || ext === 'pdf' || page, page };
}

export async function buildPreviews(opts: SandboxOpts, ctx: SandboxCtx, sourcePath: string, name: string): Promise<Previews> {
  const plan = previewPlan(name);
  if (plan.page) return fromPageThumbnail(await renderPageThumbnail(opts, ctx, sourcePath));
  const out: Previews = { notes: [] };
  if (!plan.thumbnail) return out;
  let dir: string | undefined;
  try {
    const made = await runSandboxShell(opts, ctx, 'mktemp -d');
    dir = made.stdout.trim();
    if (made.exitCode !== 0 || !dir.startsWith('/')) {
      out.notes.push('previews skipped: the computer has no temporary directory');
      return out;
    }
    let pdfPath = sourcePath;
    if (plan.convert) {
      const stem = name.replace(/\.[^.]+$/, '');
      pdfPath = dir + '/out/' + stem + '.pdf';
      const convert = await runSandboxShell(
        opts,
        ctx,
        'soffice --headless -env:UserInstallation=file://' + dir + '/profile --convert-to pdf --outdir ' + shellQuote(dir + '/out') + ' ' + shellQuote(sourcePath) + ' >/dev/null 2>&1',
        CONVERT_TIMEOUT_MS,
      );
      const pdf = convert.exitCode === 0 ? await readSandboxFile(opts, ctx, pdfPath) : undefined;
      if (pdf?.ok) out.preview = pdf.value;
      else out.notes.push('PDF preview unavailable: LibreOffice could not convert the file');
      if (out.preview === undefined) return out;
    }
    const render = await runSandboxShell(
      opts,
      ctx,
      'command -v pdftoppm >/dev/null 2>&1 || exit ' + String(NO_PDFTOPPM) + '; pdftoppm -png -f 1 -l 1 -singlefile -scale-to 800 ' + shellQuote(pdfPath) + ' ' + shellQuote(dir + '/thumb'),
    );
    if (render.exitCode === NO_PDFTOPPM) {
      out.notes.push('thumbnail skipped: pdftoppm is not installed in this computer');
      return out;
    }
    const png = render.exitCode === 0 ? await readSandboxFile(opts, ctx, dir + '/thumb.png') : undefined;
    if (png?.ok) out.thumbnail = png.value;
    else out.notes.push('thumbnail unavailable: pdftoppm could not render the first page');
    return out;
  } catch (error) {
    // An abort must still stop the run; any other computer problem only costs the previews.
    if (ctx.signal.aborted) throw error;
    out.notes.push('previews unavailable: the computer failed while rendering them');
    return out;
  } finally {
    if (dir !== undefined && dir.startsWith('/')) await runSandboxShell(opts, ctx, 'rm -rf ' + shellQuote(dir)).catch(() => undefined);
  }
}

function fromPageThumbnail(result: PageThumbnail): Previews {
  return result.thumbnail === undefined ? { notes: [result.note ?? 'thumbnail unavailable'] } : { thumbnail: result.thumbnail, notes: [] };
}

export interface PageThumbnail {
  thumbnail?: DecodedFile;
  /** Why there is no thumbnail, one line. */
  note?: string;
}

/**
 * A 600x450 PNG of an HTML file (laid out in a 1200x900 window), taken by the image's own Chromium as a one-shot process with its own profile in a temporary
 * directory, so the agent's open browser and its profile are never touched. The wrapper `/usr/bin/chromium` also passes
 * `--remote-debugging-port=9222` and the agent's profile from /etc/chromium.d; both are overridden here, so the one-shot never
 * takes the agent's DevTools port. Shared by artifact_publish and the agentd thumbnail backfill. It never throws on a computer
 * problem (other than an abort): the result carries the reason instead.
 */
export async function renderPageThumbnail(opts: SandboxOpts, ctx: SandboxCtx, htmlPath: string): Promise<PageThumbnail> {
  let dir: string | undefined;
  try {
    const made = await runSandboxShell(opts, ctx, 'mktemp -d');
    dir = made.stdout.trim();
    if (made.exitCode !== 0 || !dir.startsWith('/')) return { note: 'thumbnail skipped: the computer has no temporary directory' };
    const png = dir + '/thumb.png';
    const shot = await runSandboxShell(
      opts,
      ctx,
      'B=$(command -v chromium || command -v chromium-browser || command -v google-chrome) || exit ' + String(NO_BROWSER) + '; ' +
        '"$B" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --hide-scrollbars --no-first-run --mute-audio ' +
        '--remote-debugging-port=0 --user-data-dir=' + shellQuote(dir + '/browser') + ' --virtual-time-budget=3000 ' +
        '--window-size=' + String(PAGE_THUMBNAIL_WIDTH) + ',' + String(PAGE_THUMBNAIL_HEIGHT) + ' --force-device-scale-factor=' + String(PAGE_THUMBNAIL_SCALE) + ' --screenshot=' + shellQuote(png) + ' ' +
        shellQuote('file://' + htmlPath) + ' >/dev/null 2>&1 & C=$!; ' +
        // The image's Chromium writes the screenshot and then keeps running (measured: it never exits on its own). The file is the signal:
        // once it exists the browser is stopped; if it never comes, the loop gives up after SCREENSHOT_TIMEOUT_SECONDS.
        'i=0; while [ $i -lt ' + String(SCREENSHOT_TIMEOUT_SECONDS * 10) + ' ] && [ ! -s ' + shellQuote(png) + ' ]; do sleep 0.1; i=$((i+1)); done; ' +
        'sleep 0.5; kill $C 2>/dev/null; sleep 0.5; kill -KILL $C 2>/dev/null; test -s ' + shellQuote(png),
    );
    if (shot.exitCode === NO_BROWSER) return { note: 'thumbnail skipped: no browser is installed in this computer' };
    const read = shot.exitCode === 0 ? await readSandboxFile(opts, ctx, png) : undefined;
    if (read?.ok && read.value.sizeBytes > 0) return { thumbnail: read.value };
    return { note: 'thumbnail unavailable: the browser could not render the page' };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { note: 'thumbnail unavailable: the computer failed while rendering the page' };
  } finally {
    if (dir !== undefined && dir.startsWith('/')) await runSandboxShell(opts, ctx, 'rm -rf ' + shellQuote(dir)).catch(() => undefined);
  }
}
