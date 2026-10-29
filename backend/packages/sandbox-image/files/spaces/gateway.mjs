// Spaces gateway (BACKEND 5.12): runs as root inside the computer on port 7090, started by computerd. The platform sends
// every request for an agent's app here with `X-Juno-Space: <spaceId>`; the gateway looks the id up in /etc/juno/spaces.json
// (root-only, written by computerd) and forwards to 127.0.0.1:<port>, HTTP and WebSocket. Nothing here trusts the agent: the route file is root's, and before every
// forward the gateway checks (from the kernel's socket table) that the port is still listened on by the uid that was
// verified at registration, so an app that exited cannot be replaced by another agent's listener on the same port.
// Every request must carry `X-Juno-Gateway-Key`, the per-computer key computerd installed in a root-only file: this port is
// reachable from outside the computer (E2B's public host), where the uid firewall rules do not apply, so knowing a space id
// is not enough. Without the right key the answer is a plain 404, and the key never reaches the app.
// Two servers share the route lookup below: Bun.serve in the image (Bun's node:http cannot hand over an upgraded socket), and
// node:http plus a raw TCP tunnel under Node, which is what the tests' fake computer runs.
/* global Bun */
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';

const ROUTES_FILE = process.env.JUNO_SPACES_ROUTES ?? '/etc/juno/spaces.json';
const PORT = Number(process.env.JUNO_SPACES_PORT ?? 7090);
const HOST = process.env.JUNO_SPACES_HOST ?? '0.0.0.0';
const KEY_FILE = process.env.JUNO_SPACES_KEY_FILE ?? '/etc/juno/gateway.key';
const SPACE_ID = /^[a-z0-9]{8,64}$/;
const LISTEN_CACHE_MS = 1000;

let routes = { mtimeMs: -1, table: {} };
function route(id) {
  try {
    const stat = fs.statSync(ROUTES_FILE);
    if (stat.mtimeMs !== routes.mtimeMs) routes = { mtimeMs: stat.mtimeMs, table: JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')).routes ?? {} };
  } catch {
    routes = { mtimeMs: -1, table: {} };
  }
  const entry = Object.hasOwn(routes.table, id) ? routes.table[id] : undefined;
  return entry && Number.isInteger(entry.port) ? entry : undefined;
}

let key = { mtimeMs: -1, digest: null };
/** True when `given` is the installed key (compared as SHA-256 digests in constant time); no key file means nothing is allowed. */
function keyOk(given) {
  try {
    const stat = fs.statSync(KEY_FILE);
    if (stat.mtimeMs !== key.mtimeMs) key = { mtimeMs: stat.mtimeMs, digest: createHash('sha256').update(fs.readFileSync(KEY_FILE, 'utf8').trim()).digest() };
  } catch {
    key = { mtimeMs: -1, digest: null };
  }
  if (key.digest === null || typeof given !== 'string' || given === '') return false;
  return timingSafeEqual(key.digest, createHash('sha256').update(given).digest());
}

const LOOPBACK = new Set(['0100007F', '00000000000000000000000001000000', '0000000000000000FFFF00000100007F']);
let listening = { at: 0, sockets: [] };
function listeners() {
  if (Date.now() - listening.at < LISTEN_CACHE_MS) return listening.sockets;
  const sockets = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 8 || cols[3] !== '0A') continue;
      const [address, port] = cols[1].split(':');
      sockets.push({ port: parseInt(port, 16), uid: Number(cols[7]), loopback: LOOPBACK.has(address) });
    }
  }
  listening = { at: Date.now(), sockets };
  return sockets;
}

/** The app behind the route, or undefined when it stopped or someone else holds the port. A route without a uid (tests) skips the owner check. */
function target(id, given) {
  if (!keyOk(given) || typeof id !== 'string' || !SPACE_ID.test(id)) return undefined;
  const entry = route(id);
  if (!entry) return undefined;
  if (entry.uid === undefined || entry.uid === null) return entry;
  const onPort = listeners().filter((socket) => socket.port === entry.port);
  return onPort.length > 0 && onPort.every((socket) => socket.uid === entry.uid && socket.loopback) ? entry : undefined;
}

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-juno-space', 'x-juno-gateway-key'];

/** Space ids whose app is up: routed, still held by the verified uid, and accepting connections. Needs the key; reads only. */
async function upSpaces(given) {
  if (!keyOk(given)) return undefined;
  const up = [];
  for (const id of Object.keys(routes.table)) {
    const entry = target(id, given);
    if (entry && (await new Promise((done) => {
      const probe = net.connect(entry.port, '127.0.0.1');
      probe.setTimeout(500, () => probe.destroy());
      probe.once('connect', () => { probe.destroy(); done(true); });
      probe.once('error', () => done(false));
      probe.once('close', () => done(false));
    }))) up.push(id);
  }
  return JSON.stringify({ listening: up });
}
const NOT_FOUND = 'no such space, or its app is not running';

if (process.env.JUNO_SPACES_PIDFILE) fs.writeFileSync(process.env.JUNO_SPACES_PIDFILE, String(process.pid), { mode: 0o600 });

if (typeof Bun !== 'undefined') {
  Bun.serve({
    hostname: HOST,
    port: PORT,
    async fetch(request, server) {
      const url = new URL(request.url);
      const id = request.headers.get('x-juno-space');
      if (id === null && url.pathname === '/__health') return new Response('ok');
      const given = request.headers.get('x-juno-gateway-key');
      if (id === null && url.pathname === '/__status') {
        route('');
        const body = await upSpaces(given);
        return body === undefined ? new Response(NOT_FOUND, { status: 404 }) : new Response(body, { headers: { 'content-type': 'application/json' } });
      }
      const entry = target(id, given);
      if (!entry) return new Response(NOT_FOUND, { status: 404 });
      const headers = new Headers(request.headers);
      for (const name of HOP) headers.delete(name);
      const path = url.pathname + url.search;
      if ((request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
        const protocols = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((item) => item.trim()).filter(Boolean);
        for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol']) headers.delete(name);
        return server.upgrade(request, { data: { port: entry.port, path, headers: Object.fromEntries(headers), protocols, queue: [] } }) ? undefined : new Response('upgrade failed', { status: 400 });
      }
      try {
        return await fetch(`http://127.0.0.1:${entry.port}${path}`, { method: request.method, headers, body: request.body, redirect: 'manual', decompress: false });
      } catch {
        return new Response('the app did not answer', { status: 502 });
      }
    },
    websocket: {
      open(ws) {
        const { port, path, headers, protocols } = ws.data;
        const upstream = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, protocols });
        ws.data.upstream = upstream;
        upstream.onopen = () => {
          for (const message of ws.data.queue.splice(0)) upstream.send(message);
        };
        upstream.onmessage = (event) => ws.send(event.data);
        upstream.onclose = () => ws.close();
        upstream.onerror = () => ws.close();
      },
      message(ws, message) {
        if (ws.data.upstream.readyState === 1) ws.data.upstream.send(message);
        else ws.data.queue.push(message);
      },
      close(ws) {
        ws.data.upstream?.close();
      },
    },
  });
  console.log(`spaces gateway (bun) listening on ${HOST}:${PORT}`);
} else {
  const { default: http } = await import('node:http');
  const { default: net } = await import('node:net');
  const server = http.createServer((request, response) => {
    if (request.headers['x-juno-space'] === undefined && request.url === '/__health') {
      response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (request.headers['x-juno-space'] === undefined && request.url === '/__status') {
      route('');
      upSpaces(request.headers['x-juno-gateway-key']).then((body) => {
        if (body === undefined) response.writeHead(404, { 'content-type': 'text/plain' }).end(NOT_FOUND);
        else response.writeHead(200, { 'content-type': 'application/json' }).end(body);
      });
      return;
    }
    const entry = target(request.headers['x-juno-space'], request.headers['x-juno-gateway-key']);
    if (!entry) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end(NOT_FOUND);
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) if (!HOP.includes(name)) headers[name] = value;
    const upstream = http.request({ host: '127.0.0.1', port: entry.port, method: request.method, path: request.url, headers, agent: false }, (reply) => {
      const out = {};
      for (const [name, value] of Object.entries(reply.headers)) if (!HOP.includes(name)) out[name] = value;
      response.writeHead(reply.statusCode ?? 502, out);
      reply.pipe(response);
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('the app did not answer');
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  // WebSocket: replay the handshake to the app and tunnel the raw bytes both ways.
  server.on('upgrade', (request, socket, head) => {
    const entry = target(request.headers['x-juno-space'], request.headers['x-juno-gateway-key']);
    if (!entry) {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect(entry.port, '127.0.0.1');
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('connect', () => {
      let handshake = `${request.method} ${request.url} HTTP/1.1\r\n`;
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        if (!['x-juno-space', 'x-juno-gateway-key'].includes(request.rawHeaders[i].toLowerCase())) handshake += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(handshake + '\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  });
  server.listen(PORT, HOST, () => console.log(`spaces gateway (node) listening on ${HOST}:${PORT}`));
}
