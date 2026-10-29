/**
 * The `juno` command. `juno serve` speaks the session protocol (PROTOCOL.md) on stdin and stdout. The server
 * comes from JUNO_BASE_URL and JUNO_TOKEN, or from --base-url and --token. Diagnostics go to stderr only, so
 * stdout carries protocol lines and nothing else.
 */
import { createInterface } from 'node:readline';
import { UsageError, USAGE, resolveServeOptions, type ServeOptions } from './cli-options.js';
import { serve } from './serve.js';

const EMBEDDED_UNAVAILABLE =
  'juno serve --embedded is not available yet: @agent-desktop/embedded (startEmbeddedJuno) has no backend tag this package can depend on.\n' +
  'Start a Juno server and connect to it instead: JUNO_BASE_URL=URL JUNO_TOKEN=TOKEN juno serve (see packages/sdk/PROTOCOL.md, TODO: embedded mode).';

function fail(message: string, exitCode: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === '--help' || args.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (command !== 'serve') fail(USAGE, 2);
  if (args.includes('--embedded')) fail(EMBEDDED_UNAVAILABLE, 1);

  let options: ServeOptions;
  try {
    options = resolveServeOptions(args, process.env);
  } catch (error) {
    if (error instanceof UsageError) fail(`juno serve: ${error.message}\n${USAGE}`, 2);
    throw error;
  }
  if (options.tokenFromFlag) {
    process.stderr.write('warning: --token is visible in the process list on some systems; set JUNO_TOKEN instead\n');
  }

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  await serve(
    {
      input: lines,
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
    },
    { baseUrl: options.baseUrl, token: options.token },
  );
  lines.close();
}

main(process.argv.slice(2)).catch((error: unknown) => {
  fail(`juno serve: ${error instanceof Error ? error.message : String(error)}`, 1);
});
