/**
 * Entry point of the compiled binary (`/usr/local/bin/juno-link`), started as root at boot. Configuration comes from the
 * environment the platform created the computer with (Docker) or, where the platform cannot inject one, from the
 * root-only `/etc/juno/link.json` written once at create; the file is read again on every attempt, so a computer that
 * boots before its token exists simply waits.
 */
import { chmodSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { startLinkDaemon, type LinkConfig } from './daemon.js';

const CONFIG_FILE = process.env['JUNO_LINK_CONFIG'] ?? '/etc/juno/link.json';
// Read once before the daemon scrubs the JUNO_LINK_* variables from what its commands inherit.
const fromEnv: LinkConfig | undefined = process.env['JUNO_LINK_URL'] && process.env['JUNO_LINK_ID'] && process.env['JUNO_LINK_TOKEN']
  ? { url: process.env['JUNO_LINK_URL'], id: process.env['JUNO_LINK_ID'], token: process.env['JUNO_LINK_TOKEN'] }
  : undefined;

function loadConfig(): LinkConfig | undefined {
  if (fromEnv) return fromEnv;
  try {
    // The platform wrote it where it could not set a mode (E2B file injection): make it root-only before anything reads it.
    chmodSync(dirname(CONFIG_FILE), 0o700);
    chmodSync(CONFIG_FILE, 0o600);
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const { url, id, token } = parsed as Record<string, unknown>;
      if (typeof url === 'string' && typeof id === 'string' && typeof token === 'string') return { url, id, token };
    }
  } catch {
    // not written yet
  }
  return undefined;
}

startLinkDaemon({ loadConfig, log: (message, fields) => process.stderr.write(`juno-link: ${message} ${fields ? JSON.stringify(fields) : ''}\n`) });
