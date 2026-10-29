/**
 * agentd entry point: one process owns the private internal HTTP API and the durable runner (see boot.ts).
 * SIGINT/SIGTERM stop it gracefully, bounded to 10 s.
 */
import { createLogger } from '@agent-desktop/log';
import { startAgentd } from './boot.js';

const log = createLogger({ service: 'agentd' });

async function main() {
  const agentd = await startAgentd();
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down agentd');
    const forced = setTimeout(() => {
      log.error('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000);
    forced.unref();
    agentd.stop()
      .then(() => process.exit(0))
      .catch((error) => {
        log.error({ err: error }, 'Shutdown failed');
        process.exit(1);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  log.error({ err: error }, '✗ Fatal error');
  process.exit(1);
});
