/**
 * Entry point of the compiled binary (`/usr/local/bin/juno-link`), run as root (Docker: the image command; E2B: started
 * by computerd right after create). Configuration is the `JUNO_LINK_*` environment of that process.
 */
import { startLinkDaemon, type LinkConfig } from './daemon.js';

// Read once before the daemon scrubs the JUNO_LINK_* variables from what its commands inherit.
const fromEnv: LinkConfig | undefined = process.env['JUNO_LINK_URL'] && process.env['JUNO_LINK_ID'] && process.env['JUNO_LINK_TOKEN']
  ? { url: process.env['JUNO_LINK_URL'], id: process.env['JUNO_LINK_ID'], token: process.env['JUNO_LINK_TOKEN'] }
  : undefined;

function loadConfig(): LinkConfig | undefined {
  return fromEnv;
}

startLinkDaemon({ loadConfig, log: (message, fields) => process.stderr.write(`juno-link: ${message} ${fields ? JSON.stringify(fields) : ''}\n`) });
