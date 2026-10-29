// Renders Storybook stories to PNGs. Usage:
//   node scripts/screenshots.mjs <manifest.json>
// Manifest: { "staticDir": "...", "outDir": "...", "viewport": {width,height},
//             "themes": ["dark","light"], "stories": [{ "id": "primitives-button--variants", "name": "Button" }] }
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error("usage: node scripts/screenshots.mjs <manifest.json>");
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const staticDir = resolve(manifest.staticDir);
const outDir = resolve(manifest.outDir);
const viewport = manifest.viewport ?? { width: 1440, height: 900 };
// `themes` are @storybook/addon-themes theme KEYS (they must match the keys of
// `withThemeByDataAttribute({ themes: { Dark: "dark", Light: "light" } })`),
// not the attribute values.
const themes = manifest.themes ?? ["Dark", "Light"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    let filePath = join(staticDir, decodeURIComponent(url.pathname));
    if (!existsSync(filePath) || url.pathname === "/") {
      filePath = join(staticDir, "iframe.html");
    }
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const { chromium } = await import("playwright");
let browser;
try {
  browser = await chromium.launch();
} catch (error) {
  console.error("chromium.launch failed, falling back to channel:chrome —", String(error));
  browser = await chromium.launch({ channel: "chrome" });
}

await mkdir(outDir, { recursive: true });

const written = [];
const hashesByStory = new Map();

for (const story of manifest.stories) {
  for (const theme of themes) {
    const scheme = theme.toLowerCase();
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await context.newPage();
    const url = `${base}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story&globals=theme:${encodeURIComponent(theme)}`;
    await page.goto(url, { waitUntil: "load" });
    // Let webfonts, lazy chunks and CSS transitions settle.
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForTimeout(500);

    // Guard against a silently-ignored theme global: the page must actually
    // carry the expected data-theme attribute.
    const appliedTheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    if (appliedTheme !== scheme) {
      throw new Error(
        `theme not applied for ${story.id} (${theme}): data-theme="${appliedTheme}"`,
      );
    }

    const file = join(outDir, `${story.name}.${scheme}.png`);
    const shot = await page.screenshot({ path: file });
    written.push(file);

    const hashes = hashesByStory.get(story.name) ?? [];
    hashes.push({ theme, hash: createHash("sha1").update(shot).digest("hex") });
    hashesByStory.set(story.name, hashes);

    await context.close();
  }
}

// Every story should differ between themes — identical pixels mean the theme
// global was ignored.
const identical = [...hashesByStory.entries()]
  .filter(([, hashes]) => new Set(hashes.map((h) => h.hash)).size === 1)
  .map(([name]) => name);
if (identical.length > 0) {
  throw new Error(`these stories look identical in every theme: ${identical.join(", ")}`);
}

await browser.close();
server.close();

await writeFile(join(outDir, "index.json"), JSON.stringify(written, null, 2));
console.log(`wrote ${written.length} screenshots to ${outDir}`);
