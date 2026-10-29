/**
 * Harness for the LIVE_DOCKER tests: what they need to run a real computer over the computer link without a real computerd.
 *
 *  - `liveImage()`: compiles `juno-link` exactly as the image build does (`bun build --compile`, juno-link/build.sh) and
 *    puts it into a thin image on top of the local desktop image the way prepare_assets.py and the Dockerfile generator do
 *    (binary at /usr/local/bin/juno-link, /etc/juno 0700, root, start command = the daemon). Needs Bun: `BUN=/path/to/bun`
 *    or `bun` on PATH. Cached by the binary's hash; remove it with `docker rmi <tag>`.
 *  - `startLiveLink()`: the link endpoint of computerd (the real hub on a real WebSocket server) in this process, listening
 *    on every interface so a container reaches it at `host.docker.internal`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createLinkHub, type LinkHub } from './link-hub.js';

export const LIVE_BASE_IMAGE = 'juno-desktop:local';
const LINK_PACKAGE = join(import.meta.dirname, '..', '..', 'juno-link');

export interface LiveLink {
  hub: LinkHub;
  /** What a container dials. */
  linkUrl: string;
  close(): void;
}

/** `port` pins the endpoint so a "restarted computerd" can come back where the daemons already dial. */
export async function startLiveLink(secret = 'live-test-secret', port = 0): Promise<LiveLink> {
  const hub = createLinkHub({ secret });
  const server: Server = createServer();
  const wss = new WebSocketServer({ server, path: '/v1/computer-link' });
  wss.on('connection', (socket) => hub.accept(socket));
  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    hub,
    linkUrl: `ws://host.docker.internal:${bound}/v1/computer-link`,
    close() {
      hub.close();
      wss.close();
      server.close();
    },
  };
}

let image: string | undefined;
let spacesImage: string | undefined;
const IMAGE_FILES = join(import.meta.dirname, '..', '..', 'sandbox-image', 'files');

/** The desktop image with `juno-link` in it (built once per process, cached by content). */
export function liveImage(): string {
  if (image !== undefined) return image;
  // A ready image that already holds juno-link (no Bun needed): LIVE_IMAGE=<tag>.
  const given = process.env['LIVE_IMAGE'];
  if (given !== undefined && given !== '') return (image = given);
  const context = mkdtempSync(join(tmpdir(), 'juno-live-image-'));
  try {
    const binary = join(context, 'juno-link');
    const arch = execFileSync('docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8' }).trim();
    execFileSync('sh', [join(LINK_PACKAGE, 'build.sh')], {
      env: { ...process.env, OUT: binary, TARGET: arch === 'aarch64' || arch === 'arm64' ? 'bun-linux-arm64' : 'bun-linux-x64' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    const tag = 'juno-live-desktop:' + createHash('sha256').update(readFileSync(binary)).digest('hex').slice(0, 12);
    const have = execFileSync('docker', ['images', '-q', tag], { encoding: 'utf8' }).trim();
    if (have === '') {
      writeFileSync(
        join(context, 'Dockerfile'),
        [`FROM ${LIVE_BASE_IMAGE}`, 'USER root', 'COPY juno-link /usr/local/bin/juno-link', 'RUN chmod 0755 /usr/local/bin/juno-link && mkdir -p /etc/juno && chmod 0700 /etc/juno', 'CMD ["/usr/local/bin/juno-link"]', ''].join('\n'),
      );
      execFileSync('docker', ['build', '-q', '-t', tag, context], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    image = tag;
    return tag;
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

/**
 * `liveImage()` plus what the next image build brings for Spaces (BACKEND 5.12): `unzip`, `iptables` and `acl` (template apt
 * lines), the spaces skill and gateway at the paths prepare_assets.py uses, and the pinned Bun from the SAME install-runtime.sh the
 * build runs. Needs network (apt, GitHub). Cached by the tag it is built on.
 */
export function liveSpacesImage(): string {
  if (spacesImage !== undefined) return spacesImage;
  const base = liveImage();
  const tag = base.replace('juno-live-desktop:', 'juno-live-spaces:');
  if (execFileSync('docker', ['images', '-q', tag], { encoding: 'utf8' }).trim() === '') {
    const context = mkdtempSync(join(tmpdir(), 'juno-live-spaces-'));
    try {
      cpSync(join(IMAGE_FILES, 'skills', 'spaces'), join(context, 'skills-spaces'), { recursive: true });
      cpSync(join(IMAGE_FILES, 'spaces'), join(context, 'spaces'), { recursive: true });
      writeFileSync(
        join(context, 'Dockerfile'),
        [
          `FROM ${base}`,
          'RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends unzip iptables acl >/dev/null && rm -rf /var/lib/apt/lists/*',
          'COPY skills-spaces /opt/juno/skills/spaces',
          'COPY spaces /opt/juno/spaces',
          'RUN chown -R root:root /opt/juno && chmod -R a+rX /opt/juno && chmod 0755 /opt/juno/skills/spaces/spaces_tool.py /opt/juno/spaces/install-runtime.sh && sh /opt/juno/spaces/install-runtime.sh',
          '',
        ].join('\n'),
      );
      execFileSync('docker', ['build', '-q', '-t', tag, context], { stdio: ['ignore', 'ignore', 'inherit'] });
    } finally {
      rmSync(context, { recursive: true, force: true });
    }
  }
  spacesImage = tag;
  return tag;
}
