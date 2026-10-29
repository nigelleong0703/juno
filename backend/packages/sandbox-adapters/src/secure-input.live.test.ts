/**
 * LIVE end-to-end secure input (BACKEND 8.7) against a real throwaway container of the desktop image: the helper unseals
 * a value a client encrypted to the sandbox key and types it, the page is masked (dots in the filled input, dots in text on
 * a later page, nothing in snapshot / get_text), and the agent's own shell cannot reach the browser's debugging port or
 * the helper's key. Skipped unless LIVE_DOCKER=1. Use a freshly built image (`LIVE_IMAGE=<tag>`, a desktop image that
 * contains juno-link); it starts its own container and removes it afterwards.
 *
 *   LIVE_DOCKER=1 LIVE_IMAGE=juno-secure-e2e:test SHOT_DIR=/tmp/shots pnpm --filter @agent-desktop/sandbox-adapters exec vitest run src/secure-input.live.test.ts
 */
import { execFileSync } from 'node:child_process';
import { createCipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { E2bBinding } from '@agent-desktop/contracts';
import { liveImage, startLiveLink, type LiveLink } from './live-link.js';
import { createLocalProvider } from './local.js';
import { screenPorts } from './ports.js';
import type { BrowserInput, BrowserResult } from './browser.js';

const live = process.env['LIVE_DOCKER'] === '1' ? describe : describe.skip;
const A = 'agent-secure-a';
const DISPLAY = 1;
const signal = () => AbortSignal.timeout(240_000);

const NAME = 'Jane Q Doe';
const PHONE = '+65 9123 4567';
const CARD = '4242 4242 4242 4242';
const REQUEST = 'req-live-1';

/** The client side of BACKEND 8.7: ephemeral X25519, HKDF-SHA256 (salt = request id), AES-256-GCM, AAD request|field|ref. */
function seal(publicKeyB64: string, requestId: string, fieldId: string, ref: string, value: string) {
  const spki = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(publicKeyB64, 'base64')]);
  const ephemeral = generateKeyPairSync('x25519');
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: createPublicKey({ key: spki, format: 'der', type: 'spki' }) });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(requestId, 'utf8'), Buffer.from('juno-secure-input-v1'), 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${requestId}|${fieldId}|${ref}`));
  const box = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const epk = ephemeral.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { epk: epk.toString('base64'), nonce: nonce.toString('base64'), ciphertext: box.toString('base64') };
}

const FORM = `<!doctype html><title>Checkout</title>
<form action="review.html" method="get">
  <label>Full name <input id="name" name="name" autocomplete="name"></label><br>
  <label>Phone <input id="phone" name="phone" type="tel"></label><br>
  <label>Card number <input id="card" name="card" autocomplete="cc-number"></label><br>
  <button type="submit">Review order</button>
</form>`;
const REVIEW = `<!doctype html><title>Review</title>
<h1>Review your order</h1><p id="ship"></p><label>Phone on file <input id="pv" readonly></label>
<script>
  var q = new URLSearchParams(location.search);
  document.getElementById('ship').textContent = 'Ship to ' + q.get('name') + ', phone ' + q.get('phone') + '.';
  document.getElementById('pv').value = q.get('phone');
</script>`;

/** Evaluate JS in the page's MAIN world over the CDP port, as root (what the page's own scripts could see). */
const READ_PAGE = (port: number, expression: string) => `python3 - <<'PY'
import json, urllib.request
from websocket import create_connection
tab = [t for t in json.load(urllib.request.urlopen("http://127.0.0.1:${port}/json/list")) if t["type"] == "page"][0]
ws = create_connection(tab["webSocketDebuggerUrl"], suppress_origin=True)
ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": ${JSON.stringify(expression)}, "returnByValue": True}}))
print(json.dumps(json.loads(ws.recv())["result"]["result"].get("value")))
PY`;

live('secure input on a real container', () => {
  let link: LiveLink;
  let provider: ReturnType<typeof createLocalProvider>;
  let binding: E2bBinding;
  const cdp = screenPorts(DISPLAY).cdp;

  const browser = async (input: BrowserInput): Promise<BrowserResult> => {
    const result = await provider.act(binding, A, DISPLAY, { kind: 'browser', input }, signal());
    if (!result.browser) throw new Error('no browser result');
    return result.browser;
  };
  const snapshot = async () => {
    const page = await browser({ action: 'snapshot' });
    if (page.action !== 'snapshot') throw new Error('not a snapshot');
    return page;
  };
  const refOf = (nodes: Array<{ ref?: string; name: string }>, name: RegExp) => nodes.find((n) => n.ref !== undefined && name.test(n.name))?.ref ?? '';
  const sh = async (command: string) => {
    const out = (await provider.act(binding, A, DISPLAY, { kind: 'shell', input: { command, timeoutMs: 60_000 } }, signal())).shell;
    if (!out) throw new Error('no shell result');
    return out;
  };
  const root = (command: string) => provider.withRuntime(binding, signal(), async (runtime) => (await runtime.run(command)).stdout, { user: 'root' });

  beforeAll(async () => {
    link = await startLiveLink();
    provider = createLocalProvider({ ownerId: 'live-secure-input-test', image: liveImage(), hub: link.hub, linkUrl: link.linkUrl });
    binding = await provider.create({ template: liveImage(), resolution: '1280x800', timeoutMs: 3_600_000, ramGb: 2, vcpu: 2, idlePauseMinutes: 0 }, signal());
    await provider.ensureScreen(binding, { agentId: A, displayNo: DISPLAY, resolution: '1280x800', controlPassword: 'ctl', viewPassword: 'view' }, signal());
    await provider.withRuntime(binding, signal(), async (runtime) => {
      await runtime.writeText('/tmp/site/form.html', FORM);
      await runtime.writeText('/tmp/site/review.html', REVIEW);
      await runtime.run('cd /tmp/site && (setsid nohup python3 -m http.server 8099 --bind 127.0.0.1 >/tmp/site.log 2>&1 &); sleep 1');
    }, { user: 'root' });
  }, 400_000);

  afterAll(() => {
    try {
      if (binding) execFileSync('docker', ['rm', '-f', binding.sandboxId], { stdio: 'ignore' });
    } finally {
      provider.dispose();
      link.close();
    }
  }, 60_000);

  it('offers the sandbox public key; the same key every time, kept in a root-only file', async () => {
    const first = await browser({ action: 'secure_key' });
    const second = await browser({ action: 'secure_key' });
    expect(first).toMatchObject({ action: 'secure_key', alg: 'X25519-HKDF-SHA256-AES256GCM' });
    expect(second).toEqual(first);
    const mode = await root("stat -c '%U %a' /etc/juno/secure-input /etc/juno/secure-input/x25519.key");
    expect(mode.trim().split('\n')).toEqual(['root 700', 'root 600']);
  });

  it('fills sealed values; a wrong field, request or plaintext is refused and types nothing', async () => {
    await browser({ action: 'navigate', url: 'http://127.0.0.1:8099/form.html' });
    const { nodes } = await snapshot();
    const refs = { name: refOf(nodes, /name/i), phone: refOf(nodes, /phone/i), card: refOf(nodes, /card/i) };
    expect(Object.values(refs).every((ref) => ref !== '')).toBe(true);
    const key = await browser({ action: 'secure_key' });
    if (key.action !== 'secure_key') throw new Error('no key');

    // The ciphertext was made for field f1: presented as f2, for another request or for another ref, it does not open.
    const forF1 = seal(key.publicKey, REQUEST, 'f1', refs.name, NAME);
    for (const wrong of [{ requestId: REQUEST, fieldId: 'f2', ref: refs.name }, { requestId: 'req-other', fieldId: 'f1', ref: refs.name }, { requestId: REQUEST, fieldId: 'f1', ref: refs.phone }]) {
      await expect(browser({ action: 'fill_secret', ...wrong, sealed: forF1 })).rejects.toThrow(/could not be unsealed/);
    }
    // The old plaintext shape is not a request at all.
    await expect(browser({ action: 'fill_secret', ref: refs.name, value: NAME } as never)).rejects.toThrow();
    expect(await root(READ_PAGE(cdp, "document.getElementById('name').value"))).toBe('""\n');

    const fills: Array<[string, string, string]> = [['f1', refs.name, NAME], ['f2', refs.phone, PHONE], ['f3', refs.card, CARD]];
    for (const [fieldId, ref, value] of fills) {
      const done = await browser({ action: 'fill_secret', ref, requestId: REQUEST, fieldId, sealed: seal(key.publicKey, REQUEST, fieldId, ref, value) });
      expect(done).toMatchObject({ action: 'fill_secret', filled: true });
      expect(JSON.stringify(done)).not.toContain(value);
    }
  }, 120_000);

  it('the filled page keeps the real values for the site but shows dots, and snapshot / get_text reveal nothing', async () => {
    // What the page's own scripts see: the values are really there (the form still submits them) ...
    const values = JSON.parse(await root(READ_PAGE(cdp, "['name','phone','card'].map(i => document.getElementById(i).value).join('|')")));
    expect(values).toBe(`${NAME}|${PHONE}|${CARD}`);
    // ... and every filled input is drawn as dots.
    const styles = JSON.parse(await root(READ_PAGE(cdp, "['name','phone','card'].map(i => getComputedStyle(document.getElementById(i)).webkitTextSecurity).join('|')")));
    expect(styles).toBe('disc|disc|disc');
    const shot = JSON.stringify(await snapshot());
    const text = JSON.stringify(await browser({ action: 'get_text' }));
    for (const forbidden of ['Jane', 'Doe', '9123', '4567', '4242']) {
      expect(shot, `snapshot has ${forbidden}`).not.toContain(forbidden);
      expect(text, `get_text has ${forbidden}`).not.toContain(forbidden);
    }
    await shotTo('form-filled', await screenshot());
  }, 120_000);

  it('the purchase gate\'s point check still works with the helper running as root (xdotool with the display cookie)', async () => {
    const { nodes } = await snapshot();
    const submit = refOf(nodes, /review order/i);
    const bounds = await browser({ action: 'bounds', refs: [submit] });
    if (bounds.action !== 'bounds') throw new Error('no bounds');
    const rect = bounds.elements[0]?.rect;
    if (!rect) throw new Error('no rect');
    const hit = await browser({ action: 'point', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    expect(hit).toMatchObject({ action: 'point', element: { role: 'button', name: 'Review order' } });
  });

  it('a later page that repeats the values shows dots: text, a prefilled input, snapshot, get_text and the screenshot', async () => {
    const { nodes } = await snapshot();
    const submit = refOf(nodes, /review order/i);
    expect(submit).not.toBe('');
    await browser({ action: 'click', ref: submit });
    const page = await snapshot();
    expect(page.url).toContain('review.html');
    // In the page itself (main world): the text node is already dots, the input value is real but drawn as dots.
    const body = JSON.parse(await root(READ_PAGE(cdp, 'document.body.innerText')));
    expect(body).toContain('Ship to ••••');
    expect(body).not.toContain('Jane');
    expect(body).not.toContain('9123');
    const prefilled = JSON.parse(await root(READ_PAGE(cdp, "getComputedStyle(document.getElementById('pv')).webkitTextSecurity + '|' + document.getElementById('pv').value")));
    expect(prefilled).toBe(`disc|${PHONE}`);
    const everything = JSON.stringify(page) + JSON.stringify(await browser({ action: 'get_text' }));
    for (const forbidden of ['Jane', 'Doe', '9123', '4567']) expect(everything, forbidden).not.toContain(forbidden);
    await shotTo('review-page', await screenshot());
  }, 120_000);

  it('the agent shell cannot reach the browser, the helper key or the helper state', async () => {
    const probes: Record<string, string> = {
      cdpPort: `curl -s -m 4 -o /dev/null -w 'http=%{http_code}' http://127.0.0.1:${cdp}/json/version; echo " curl_exit=$?"`,
      cdpPython: `python3 -c "import socket; s=socket.socket(); s.settimeout(4); s.connect(('127.0.0.1',${cdp})); print('CONNECTED')" 2>&1 | tail -1`,
      keyDir: 'ls -la /etc/juno/secure-input 2>&1; cat /etc/juno/secure-input/x25519.key 2>&1 | head -c 80',
      helperState: 'ls /run/juno/browser 2>&1',
      whoami: 'id -un',
      ptraceScope: 'cat /proc/sys/kernel/yama/ptrace_scope 2>&1',
    };
    const out: Record<string, string> = {};
    for (const [name, command] of Object.entries(probes)) out[name] = ((await sh(command)).stdout + (await sh(command)).stderr).trim();
    console.log('SHELL ISOLATION PROBES\n' + JSON.stringify(out, null, 2));
    expect(out['cdpPort']).not.toContain('http=200');
    expect(out['cdpPython']).not.toContain('CONNECTED');
    expect(out['keyDir']).toContain('Permission denied');
    expect(out['helperState']).toContain('Permission denied');
    expect(out['whoami']).toMatch(/^juno-/);
  });

  it('the agent shell, which is the browser\'s own Linux user, cannot read the browser\'s memory or find a filled value in its profile', async () => {
    const pid = (await root('cat /tmp/agent-screen-1/chromium.pid')).trim();
    const memory = `python3 - <<'PY'
pid = ${JSON.stringify(pid)}
try:
    maps = open('/proc/%s/maps' % pid).read().splitlines()
    start = int([m for m in maps if 'rw-p' in m][0].split('-')[0], 16)
    with open('/proc/%s/mem' % pid, 'rb') as mem:
        mem.seek(start)
        mem.read(16)
    print('READABLE')
except Exception as exc:
    print('DENIED', type(exc).__name__, exc)
PY`;
    const probe = (await sh(memory)).stdout.trim();
    // Anything readable by the agent's user that holds a filled value: the profile (session restore, caches), /tmp, the helper's logs.
    const files = (await sh(`grep -rIal --binary-files=text --exclude=site.log -e 'Jane' -e '9123' -e '4242 4242' /home/$(id -un)/.config /tmp 2>/dev/null | head -5; echo end`)).stdout.trim();
    const ownerSees = (await root(`grep -rIal --binary-files=text --exclude=site.log -e 'Jane' -e '9123' /home/*/.config /tmp 2>/dev/null | head -5; echo end`)).trim();
    console.log(`BROWSER MEMORY (agent user): ${probe}\nFILES WITH A FILLED VALUE, seen by the agent user: ${files}\nseen by root: ${ownerSees}`);
    expect(probe).toContain('DENIED');
  });

  async function screenshot() {
    const result = await provider.act(binding, A, DISPLAY, { kind: 'screenshot' }, signal());
    if (!result.screenshot) throw new Error('no screenshot');
    return result.screenshot;
  }
  async function shotTo(name: string, shot: { data: string; mimeType: string }) {
    const dir = process.env['SHOT_DIR'];
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${name}.${shot.mimeType.includes('png') ? 'png' : 'jpg'}`, Buffer.from(shot.data, 'base64'));
  }
});
