// Live check of the packaged agent-browser helper through the real adapter, on an owned
// throwaway sandbox (removed at the end; user sandboxes untouched). COMPUTER_PROVIDER from
// .env picks local Docker (image LOCAL_SANDBOX_IMAGE, rebuild with
// packages/sandbox-image/local/build.sh first) or self-hosted E2B (template E2B_TEMPLATE).
// Run from packages/computerd: node --import tsx ../../scripts/verify/sandbox-cdp-image-live.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createE2bProvider } from '../../packages/sandbox-adapters/src/e2b.ts';
import { createLocalProvider } from '../../packages/sandbox-adapters/src/local.ts';
import { loadComputerConfig } from '../../packages/sandbox-adapters/src/config.ts';

process.loadEnvFile(new URL('../../.env', import.meta.url));
const c = loadComputerConfig();
const local = c.COMPUTER_PROVIDER === 'local';
const agentId = `cdp-image-qa-${Date.now()}`;
const displayNo = 2;
const signal = AbortSignal.timeout(300_000);
const host = { template: c.E2B_TEMPLATE, resolution: '1280x800', timeoutMs: 300_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 5 };

let provider, sdk, Sandbox, binding, remote;
if (local) {
  provider = createLocalProvider({ ownerId: agentId, image: c.LOCAL_SANDBOX_IMAGE });
} else {
  assert(c.E2B_API_URL && c.E2B_SANDBOX_URL && c.E2B_API_KEY, 'explicit self-hosted E2B configuration required');
  sdk = { apiKey: c.E2B_API_KEY, apiUrl: c.E2B_API_URL, sandboxUrl: c.E2B_SANDBOX_URL, requestTimeoutMs: 30_000 };
  ({ Sandbox } = createRequire(new URL('../../packages/sandbox-adapters/package.json', import.meta.url))('@e2b/desktop'));
  provider = createE2bProvider({ ...sdk, template: c.E2B_TEMPLATE, domain: c.E2B_DOMAIN, timeoutMs: 180_000, existingSandboxId: '' });
}

async function sh(command) {
  if (local) return execFileSync('docker', ['exec', binding.sandboxId, 'bash', '-lc', command], { encoding: 'utf8' });
  const result = await remote.commands.run(command, { timeoutMs: 15_000 });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}
async function browser(input) {
  const result = await provider.act(binding, agentId, displayNo, { kind: 'browser', input }, signal);
  assert(result.browser);
  return result.browser;
}
const refOf = (shot, name) => shot.nodes.find((n) => n.name === name)?.ref;

try {
  binding = await provider.create(host, signal);
  console.log(`Created isolated ${local ? 'local' : 'E2B'} QA sandbox`, binding.sandboxId);
  if (!local) remote = await Sandbox.connect(binding.sandboxId, { ...sdk, timeoutMs: 180_000 });
  await sh('test -x /usr/local/bin/agent-browser && PYTHONPATH=/usr/local/bin python3 -c "import websocket,agent_browser_refs"');
  await provider.ensureScreen(binding, { agentId, displayNo, resolution: '1280x800', controlPassword: 'cdpqatst', viewPassword: 'cdpqavw1' }, signal);

  // main.html: a same-origin iframe (same renderer) and a cross-origin one (localhost vs 127.0.0.1).
  await sh(`mkdir -p /tmp/cdp-qa && cd /tmp/cdp-qa && cat > main.html <<'EOF'
<title>Packaged CDP</title><div style="height:300px">spacer</div><label>Email<input aria-label="Email"></label>
<button onclick="this.textContent='Clicked'">Confirm</button>
<iframe src="/frame.html" style="position:absolute;left:400px;top:150px;width:300px;height:150px"></iframe>
<iframe src="http://localhost:18182/frame.html" style="width:300px;height:150px"></iframe>
EOF
cat > frame.html <<'EOF'
<button onclick="parent.document.title='frame-clicked'">Frame button</button><input aria-label="Frame email">
EOF
cat > other.html <<'EOF'
<title>Other</title><button onclick="document.title='other-clicked'">Other button</button>
EOF
cat > dialogs.html <<'EOF'
<title>Dialogs</title><button onclick="setTimeout(()=>alert('Product added'),200)">Add to cart</button>
<button onclick="document.title=confirm('Place order for $360?')?'ordered':'kept'">Place Order</button>
<button onclick="document.title=prompt('Your name?','')">Name</button>
<button onclick="window.open('/popup.html','pop','width=400,height=300')">Sign in</button>
EOF
cat > popup.html <<'EOF'
<title>Popup</title><button onclick="window.close()">Done</button>
EOF
(nohup python3 -m http.server 18181 --bind 127.0.0.1 >/dev/null 2>&1 &); (nohup python3 -m http.server 18182 --bind 127.0.0.1 >/dev/null 2>&1 &)
curl -fsS --retry-connrefused --retry 5 --retry-max-time 10 -o /dev/null http://127.0.0.1:18181/main.html`);

  const navigate = await provider.act(binding, agentId, displayNo, { kind: 'navigate', url: 'http://127.0.0.1:18181/main.html' }, signal);
  assert.equal(navigate.navigate?.title, 'Packaged CDP');
  const shot = await browser({ action: 'snapshot' });
  for (const name of ['Email', 'Confirm', 'Frame button', 'Frame email']) assert.match(refOf(shot, name) ?? '', /^e\d+$/, name);
  // The cross-origin iframe is read through its own CDP session: its controls carry the iframe's host.
  const foreign = shot.nodes.filter((n) => n.site === 'localhost').map((n) => n.name);
  assert.deepEqual(foreign.sort(), ['Frame button', 'Frame email']);
  assert.equal(shot.crossOriginFrames, 0);
  const foreignEmail = shot.nodes.find((n) => n.site === 'localhost' && n.name === 'Frame email').ref;
  await browser({ action: 'type', ref: foreignEmail, text: 'oopif@example.com' });
  const [rect] = (await browser({ action: 'bounds', refs: [foreignEmail] })).elements;
  // The screen is 1280x800, so model coordinates are framebuffer pixels: the point check finds the same field.
  const hit = await browser({ action: 'point', x: rect.rect.x + rect.rect.width / 2, y: rect.rect.y + rect.rect.height / 2 });
  assert.deepEqual(hit.element, { role: 'textbox', name: 'Frame email' });

  await browser({ action: 'type', ref: refOf(shot, 'Email'), text: 'first' });
  await browser({ action: 'type', ref: `@${refOf(shot, 'Email')}`, text: 'replacement' });
  await browser({ action: 'type', ref: refOf(shot, 'Email').slice(1), text: '' });
  await browser({ action: 'type', ref: refOf(shot, 'Frame email'), text: 'me@example.com' });
  assert.equal((await browser({ action: 'click', ref: refOf(shot, 'Frame button') })).title, 'frame-clicked');

  // A second tab: refs carry their tab, so interleaved clicks land on their own page.
  const other = await browser({ action: 'new_tab', url: 'http://127.0.0.1:18181/other.html' });
  const otherShot = await browser({ action: 'snapshot' });
  assert.equal(otherShot.tab, other.tab);
  const confirm = await browser({ action: 'click', ref: refOf(shot, 'Confirm') });
  assert.equal(confirm.tab, shot.tab);
  assert((await browser({ action: 'get_text', tab: shot.tab })).text.includes('Clicked'));
  assert.equal((await browser({ action: 'click', ref: refOf(otherShot, 'Other button') })).title, 'other-clicked');
  assert.equal((await browser({ action: 'tabs' })).tabs.length, 2);
  await browser({ action: 'snapshot', tab: shot.tab });
  assert.equal((await browser({ action: 'click', ref: refOf(shot, 'Confirm') })).tab, shot.tab); // surviving node keeps its ref

  // Native dialogs: an alert is accepted and reported; a confirm blocks the tab until browser.dialog answers it.
  await browser({ action: 'navigate', tab: shot.tab, url: 'http://127.0.0.1:18181/dialogs.html' });
  await assert.rejects(browser({ action: 'click', ref: refOf(shot, 'Confirm') }), /stale ref/); // document replacement invalidates it
  const dialogs = await browser({ action: 'snapshot', tab: shot.tab });
  await browser({ action: 'click', ref: refOf(dialogs, 'Add to cart') });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual((await browser({ action: 'get_text', tab: shot.tab })).alerts, [{ tab: shot.tab, message: 'Product added' }]);
  const ordered = await browser({ action: 'click', ref: refOf(dialogs, 'Place Order') });
  assert.equal(ordered.dialog?.type, 'confirm');
  assert.equal(ordered.dialog?.message, 'Place order for $360?');
  const blocked = await browser({ action: 'snapshot', tab: shot.tab });
  assert.equal(blocked.nodes.length, 0);
  assert.equal(blocked.dialog?.type, 'confirm');
  await assert.rejects(browser({ action: 'click', ref: refOf(dialogs, 'Name') }), /dialog is open/);
  assert.equal((await browser({ action: 'point', x: 5, y: 5 })).dialog?.message, 'Place order for $360?');
  assert.equal((await browser({ action: 'dialog', tab: shot.tab, accept: true })).handled?.accepted, true);
  assert.equal((await browser({ action: 'get_text', tab: shot.tab })).title, 'ordered');
  await browser({ action: 'click', ref: refOf(dialogs, 'Name') });
  await browser({ action: 'dialog', tab: shot.tab, accept: true, text: 'Juno' });
  assert.equal((await browser({ action: 'get_text', tab: shot.tab })).title, 'Juno');

  // A popup (window.open): the after-action snapshot follows it; when it closes itself, back to the opener.
  const signIn = await browser({ action: 'click', ref: refOf(dialogs, 'Sign in') });
  const popup = await browser({ action: 'snapshot', tab: signIn.tab, follow: true });
  assert.equal(popup.title, 'Popup');
  assert.notEqual(popup.tab, shot.tab);
  const done = await browser({ action: 'click', ref: refOf(popup, 'Done') });
  const back = await browser({ action: 'snapshot', tab: done.tab, follow: true });
  assert.equal(back.tab, shot.tab);
  assert([...(done.closed ?? []), ...(back.closed ?? [])].some((c) => c.tab === popup.tab && c.opener === shot.tab), 'popup close reported');

  // The real site from the slow 2026-10-12 run: open the origin picker, type, pick by ref.
  await browser({ action: 'navigate', tab: shot.tab, url: 'https://www.google.com/travel/flights?hl=en&curr=SGD' });
  const flights = await browser({ action: 'snapshot', tab: shot.tab });
  const from = flights.nodes.find((n) => n.role === 'combobox' && /where from/i.test(n.name));
  assert(from, 'origin combobox listed');
  await browser({ action: 'click', ref: from.ref });
  const picker = (await browser({ action: 'snapshot', tab: shot.tab })).nodes;
  const input = picker.find((n) => n.role === 'combobox' && /where (from|else)/i.test(n.name)) ?? from;
  await browser({ action: 'type', ref: input.ref, text: 'Singapore' });
  let options = [];
  for (let i = 0; i < 8 && !options.some((n) => /\(SIN\)/.test(n.name)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    options = (await browser({ action: 'snapshot', tab: shot.tab })).nodes.filter((n) => n.role === 'option');
  }
  const changi = options.find((n) => /\(SIN\)/.test(n.name));
  assert(changi, 'Changi (SIN) suggestion listed');
  await browser({ action: 'click', ref: changi.ref });

  const pixels = await provider.act(binding, agentId, displayNo, { kind: 'screenshot' }, signal);
  assert.equal(pixels.screenshot?.width, 1280);
  assert.equal(pixels.screenshot?.height, 800);
  console.log('PASS packaged helper: short refs, same-origin and cross-origin iframes, point, dialogs, popup follow/return, two tabs, stale ref, Google Flights origin pick, CUA screenshot');
} finally {
  if (binding) {
    if (local) execFileSync('docker', ['rm', '-f', binding.sandboxId]);
    else await Sandbox.kill(binding.sandboxId, sdk);
    console.log('Removed owned QA sandbox; user sandboxes unchanged');
  }
  provider.dispose?.();
}
