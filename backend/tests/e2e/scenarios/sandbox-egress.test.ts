import { describe, expect, it } from 'vitest';
import { createAccount, scriptedChat, toolCall, waitForToolActivity } from '../harness/client';

/**
 * Egress guard (BACKEND §7.9a) through the whole stack: an agent's shell in a real local Docker computer cannot open a
 * connection to the cloud metadata address or a private address, while a public https URL works. The computer link is up the
 * whole time (the shell runs over it). Opt-in like the other real-computer scenarios:
 * `E2E_COMPUTER_PROVIDER=local` (image `juno-desktop:local`, internet).
 */
describe.skipIf(process.env['E2E_COMPUTER_PROVIDER'] !== 'local')('sandbox egress guard', () => {
  it('refuses metadata and private addresses from the agent shell, allows the public internet', async () => {
    const account = await createAccount('sandbox-egress');
    const agent = await account.api('POST', '/v1/agents', { name: 'Fetcher' });
    expect(agent.status).toBe(201);
    const probe = (url: string) => `curl -s -m 6 -o /dev/null -w 'http=%{http_code} ' ${url}; echo "curl-exit=$?"`;
    const { sessionKey } = await scriptedChat(account, agent.body.id, [
      { toolCalls: [toolCall('c1', 'shell.run', { command: probe('http://169.254.169.254/latest/meta-data/') })] },
      { toolCalls: [toolCall('c2', 'shell.run', { command: probe('http://10.0.0.1/') })] },
      { toolCalls: [toolCall('c3', 'shell.run', { command: probe('https://example.com') })] },
      { text: 'PROBED' },
    ], 'check the network');
    const activity = await waitForToolActivity(sessionKey, (a) => a.results.length >= 3, 120_000);
    const [metadata, privateNet, publicNet] = activity.results.map((r) => r.text);
    expect(metadata).toContain('curl-exit=7');
    expect(privateNet).toContain('curl-exit=7');
    expect(publicNet).toContain('http=200');
    expect(publicNet).toContain('curl-exit=0');
  }, 180_000);
});
