// Bundles @novnc/novnc (the web app's VNC client, packages/app/src/components/computer/live) into one self-contained ES module
// script, inlined as a <script type="module"> in the iOS WKWebView screen (imports from a local page are blocked there).
// Run from packages/ios: node tools/build-novnc.mjs  → Juno/Features/Workspace/Screen/novnc.js
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(new URL('../../app/package.json', import.meta.url));
const esbuild = require(require.resolve('esbuild', { paths: [new URL('../../../node_modules/.pnpm/esbuild@0.25.12/node_modules', import.meta.url).pathname] }));
const rfb = require.resolve('@novnc/novnc');
mkdirSync(new URL('../Juno/Features/Workspace/Screen/', import.meta.url), { recursive: true });
await esbuild.build({
  stdin: { contents: `import RFB from ${JSON.stringify(rfb)}; window.RFB = RFB;`, resolveDir: process.cwd(), loader: 'js' },
  bundle: true, format: 'esm', minify: true, target: 'safari17',
  outfile: new URL('../Juno/Features/Workspace/Screen/novnc.js', import.meta.url).pathname,
  legalComments: 'inline',
});
console.log('wrote Juno/Features/Workspace/Screen/novnc.js');
