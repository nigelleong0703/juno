/**
 * Public API entry point: account-mode gateway on API_PORT (default 8787). The start-up lives in boot.ts (so the
 * embedded runtime can start the same gateway in-process). SIGINT/SIGTERM stop accepting, drain,
 * then close the pool before exiting.
 */
import { createLogger } from '@agent-desktop/log';
import { forceClose, startApi } from './boot.js';

const log = createLogger({ service: 'api' });

async function main(): Promise<void> {
  const api = await startApi(process.env);
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'Shutting down public API');
    const forced = setTimeout(() => {
      forceClose(api.server);
      void api.closeDurableConnections().finally(() => process.exit(1));
    }, 10000);
    forced.unref();
    api.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  log.error({ err: error }, 'Fatal error');
  process.exit(1);
});
