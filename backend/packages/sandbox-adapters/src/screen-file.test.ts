import { describe, expect, it } from 'vitest';
import type { SandboxRuntime } from './runtime.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScreenFile, modelImageDimensions } from './screen-file.js';
import { modelToScreenShell } from './model-screen.js';
import { xdotoolClick } from './screen-diagnostics.js';
import { browserCommand } from './browser.js';

/** A PNG header with the given IHDR size (enough for imageInfo/pngSize). */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A JPEG header with the given SOF0 size (enough for imageInfo). */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(20);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8]);
  bytes[7] = height >> 8;
  bytes[8] = height & 0xff;
  bytes[9] = width >> 8;
  bytes[10] = width & 0xff;
  return bytes;
}

/** A sandbox whose capture is a PNG of the given size; `encoder` says whether ffmpeg can write the JPEG. */
function runtimeFor(width: number, height: number, encoder: boolean) {
  const commands: string[] = [];
  const model = modelImageDimensions(width, height);
  const runtime: SandboxRuntime = {
    async run(command) {
      commands.push(command);
      const jpegEncode = command.includes('-model.jpg');
      return { stdout: '', stderr: '', exitCode: jpegEncode && !encoder ? 1 : 0 };
    },
    async readText() { return ''; },
    async readBytes(path) {
      if (path.endsWith('-model.jpg')) return jpeg(model.width, model.height);
      if (path.endsWith('-fit.png')) return png(model.width, model.height);
      return png(width, height);
    },
    async writeText() {},
    async writeBytes() {},
  };
  return { runtime, commands };
}

describe('screenshot preparation (model screen: fit 1280x800, then Codex: fit to 2048; JPEG when an encoder is present)', () => {
  it('encodes a screen that already fits as JPEG at its own size', async () => {
    const { runtime, commands } = runtimeFor(1280, 800, true);
    const shot = await createScreenFile().screenshot(runtime, 1);
    expect(shot).toMatchObject({ mimeType: 'image/jpeg', width: 1280, height: 800 });
    expect(commands.some((command) => command.includes('-q:v 6') && command.includes('-model.jpg'))).toBe(true);
  });

  it('scales a 1440x900 screen to 1280x800 for the model, as JPEG', async () => {
    const { runtime, commands } = runtimeFor(1440, 900, true);
    const shot = await createScreenFile().screenshot(runtime, 1);
    expect(commands.some((command) => command.includes('ffmpeg') && command.includes('scale=1280:800') && command.includes('-model.jpg'))).toBe(true);
    expect(shot).toMatchObject({ mimeType: 'image/jpeg', width: 1280, height: 800 });
    expect(Buffer.from(shot.data, 'base64')[0]).toBe(0xff);
  });

  it('falls back to PNG, scaled, when the image has no encoder', async () => {
    const { runtime, commands } = runtimeFor(1440, 900, false);
    const shot = await createScreenFile().screenshot(runtime, 1);
    expect(commands.some((command) => command.startsWith('ffmpeg') && command.includes('scale=1280:800') && command.includes('-fit.png'))).toBe(true);
    expect(shot).toMatchObject({ mimeType: 'image/png', width: 1280, height: 800 });
  });

  it('keeps the aspect ratio of a portrait or odd screen inside the box', () => {
    expect(modelImageDimensions(3000, 2000)).toEqual({ width: 1200, height: 800 });
    expect(modelImageDimensions(900, 1440)).toEqual({ width: 800, height: 1280 });
    expect(modelImageDimensions(1024, 768)).toEqual({ width: 1024, height: 768 });
  });
});

describe('model coordinates back to the framebuffer', () => {
  /** Run the generated shell prefix against a fake xdotool reporting this display size; returns "$1 $2". */
  function mapped(display: string, x: number, y: number): string {
    const bin = mkdtempSync(join(tmpdir(), 'xdotool-'));
    writeFileSync(join(bin, 'xdotool'), `#!/bin/sh\necho ${display}\n`, { mode: 0o755 });
    return execFileSync('sh', ['-c', `${modelToScreenShell(x, y)}; echo "$1 $2"`], { env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` }, encoding: 'utf8' }).trim();
  }

  it('scales clicks by the same factor as the screenshot, from the live display size', () => {
    expect(mapped('1440 900', 1280, 800)).toBe('1440 900');
    expect(mapped('1440 900', 640, 400)).toBe('720 450');
    expect(mapped('1440 900', 101, 33)).toBe('114 37');
    expect(mapped('1280 800', 101, 33)).toBe('101 33');
  });

  it('builds the click and the browser point check on the mapped point', () => {
    expect(xdotoolClick({ x: 10, y: 20 }, 1, 2)).toMatch(/^set -- .*; xdotool mousemove --sync "\$1" "\$2" click --repeat 2 --delay 100 1$/);
    const point = browserCommand(3, { action: 'point', x: 10, y: 20 });
    expect(point).toContain(`export DISPLAY=:3; XAUTHORITY="$(cat '/run/juno/screen-3/xauth' 2>/dev/null)"; export XAUTHORITY; set -- $(xdotool getdisplaygeometry`);
    expect(point).toContain(`--request "$(printf '{"action":"point","x":%s,"y":%s}' "$1" "$2")"`);
    expect(browserCommand(3, { action: 'point' })).toContain(`--request '{"action":"point"}'`);
  });
});
