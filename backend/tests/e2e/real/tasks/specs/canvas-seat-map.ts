import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { callsOf, lastReply } from '../observe';
import { verdict, type CheckEnv, type Observed, type TaskSpec } from '../types';
import { commonChecks } from './common';

/**
 * A seat map drawn on a <canvas> (Ticketmaster, 2026-11-02): there is no control in the page snapshot, so the agent must look at a
 * screenshot and click coordinates. The page tells a small server what seat was clicked, shows "Selected: <seat>" in the DOM and
 * turns the seat green. The case passes only when a seat of section 334 was really selected.
 *
 * The agent's computer is closed to private networks and the agent may not open local addresses (BACKEND 7.9a, tool-policy
 * builtin.private-network), so a page cannot come from this machine. The case starts the server inside the computer's own network
 * namespace and opens the page in the computer's Chromium itself (the user "already has the page open"); the message says "this page".
 */
const PORT = 18_476;
const LOG = '/tmp/seat-picks.log';

const SECTIONS = ['332', '333', '334', '335'];
const PAGE = `<title>Pick your seat</title><body style="margin:0;font:16px sans-serif">
<h2 style="margin:8px">Choose a seat</h2><p id="sel" style="margin:8px">Selected: none</p>
<canvas id="map" width="760" height="300" style="margin:8px;border:1px solid #888"></canvas>
<script>
const SECTIONS = ${JSON.stringify(SECTIONS)}, SEAT = 36, GAP = 6, OX = 20, SW = 180, TOP = 50;
const seats = [];
SECTIONS.forEach((name, s) => { for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) seats.push({ id: name + '-R' + (r + 1) + 'S' + (c + 1), x: OX + s * SW + c * (SEAT + GAP), y: TOP + r * (SEAT + GAP), on: false }); });
const g = document.getElementById('map').getContext('2d');
function draw() {
  g.clearRect(0, 0, 760, 300); g.font = '18px sans-serif'; g.fillStyle = '#000';
  SECTIONS.forEach((name, s) => g.fillText('Section ' + name, OX + s * SW, 32));
  for (const seat of seats) { g.fillStyle = seat.on ? '#1a9d3c' : '#cfd8e3'; g.fillRect(seat.x, seat.y, SEAT, SEAT); }
}
document.getElementById('map').addEventListener('click', (e) => {
  const box = e.target.getBoundingClientRect(), x = e.clientX - box.left - 1, y = e.clientY - box.top - 1;
  const hit = seats.find((t) => x >= t.x && x < t.x + SEAT && y >= t.y && y < t.y + SEAT);
  if (!hit) return;
  seats.forEach((t) => { t.on = t === hit; }); draw();
  document.getElementById('sel').textContent = 'Selected: ' + hit.id;
  fetch('/pick?seat=' + hit.id, { method: 'POST' });
});
draw();
</script></body>`;

const SERVER = `
import http.server, urllib.parse
PAGE = ${JSON.stringify(PAGE)}.encode()
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('content-type', 'text/html; charset=utf-8'); self.end_headers(); self.wfile.write(PAGE)
    def do_POST(self):
        seat = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('seat', [''])[0]
        open('${LOG}', 'a').write(seat + '\\n')
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
http.server.ThreadingHTTPServer(('127.0.0.1', ${PORT}), H).serve_forever()
`;

const docker = (args: string[], input?: string): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...(input === undefined ? {} : { input }) });

/** `docker exec` into the computer. The provider pauses an idle computer and resumes it on the next agent action; this does the same first. */
function exec(container: string, args: string[], input?: string): string {
  try {
    docker(['unpause', container]);
  } catch {
    // not paused
  }
  return docker(['exec', ...(input === undefined ? [] : ['-i']), container, ...args], input);
}

/** The case's computer: the one container the owner's label finds. */
function containerOf(ownerId: string): string {
  const label = `label=dev.agent-desktop.owner=${createHash('sha256').update(ownerId).digest('hex')}`;
  const id = docker(['ps', '-q', '--filter', label]).split('\n').find(Boolean);
  if (id === undefined) throw new Error('the owner has no running computer');
  return id;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const inNamespace = (container: string, script: string): string => exec(container, ['sh', '-c', `NS=$(ip netns list | awk '{print $1}' | head -n 1); ip netns exec $NS sh -c ${JSON.stringify(script)}`]);

/** Seats the page reported, read from the computer; replaced by the checks test. */
export const seatPicks = {
  owner: '',
  read(): string[] {
    return exec(containerOf(this.owner), ['sh', '-c', `cat ${LOG} 2>/dev/null || true`]).split('\n').filter(Boolean);
  },
};

async function openSeatPage(env: CheckEnv): Promise<void> {
  seatPicks.owner = env.userId;
  const container = containerOf(env.userId);
  exec(container, ['sh', '-c', 'cat > /tmp/seat_server.py'], SERVER);
  exec(container, ['sh', '-c', `rm -f ${LOG}`]);
  exec(container, ['sh', '-c', `NS=$(ip netns list | awk '{print $1}' | head -n 1); nohup ip netns exec $NS python3 /tmp/seat_server.py >/dev/null 2>&1 &`]);
  // The agent's Chromium is reached through the debugging endpoint inside the agent's namespace (9223, what the browser tools use);
  // it takes a moment to be up.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const out = inNamespace(container, `curl -s -m 5 -X PUT 'http://127.0.0.1:9223/json/new?http://127.0.0.1:${PORT}/seats'`);
      if (out.includes('"id"')) return;
    } catch {
      // not up yet
    }
    await sleep(2000);
  }
  throw new Error('could not open the seat page in the computer\'s browser');
}

const GAVE_UP = /识别不到|点不了|无法点击|没法点|画布.*(不是|无法)|can'?t (click|select)|cannot (click|select)|unable to (click|select)/i;
const clicks = (o: Observed) => callsOf(o, 'computer.click', 'computer.batch');

export const canvasSeatMap: TaskSpec = {
  id: 'canvas-seat-map',
  title: 'Canvas seat map: select a seat in section 334 by clicking coordinates',
  timeoutMs: 600_000,
  before: openSeatPage,
  turns: [{ message: '我已经在你电脑的浏览器里打开了选座页面。在这个页面选 334 区的一个座位。' }],
  user: { fallbackReply: '选哪个都行', defaultApproval: 'deny' },
  checks: [
    (o) => commonChecks(o),
    (o) => [verdict('the model clicked on the screen', clicks(o).length > 0, 'no computer.click call')],
    () => {
      const picks = seatPicks.read();
      return [verdict('a seat of section 334 is selected on the page', picks.length > 0 && picks[picks.length - 1]!.startsWith('334-'), `the page saw: ${picks.join(', ') || 'no click'}`)];
    },
    (o) => [verdict('the reply does not say it cannot click', !GAVE_UP.test(lastReply(o)), `reply: ${lastReply(o).slice(0, 200)}`)],
  ],
};
