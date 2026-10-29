/**
 * CH1 secret hygiene: a channel `?key=` secret is verified by the gateway and must never travel
 * upstream, exactly like the hook `?key=` secret. Any other route keeps its query untouched.
 */
import { describe, expect, it } from 'vitest';
import { upstreamUrl } from '../proxy.js';

describe('channel secret query stripping', () => {
  it('strips the caller secret from the upstream channel URL', () => {
    expect(upstreamUrl('http://agentd/', 'http://api/v1/channels/telegram/bot-1/events?key=secret')).toBe(
      'http://agentd/v1/channels/telegram/bot-1/events',
    );
  });

  it('keeps the hook behavior and preserves every other query', () => {
    expect(upstreamUrl('http://agentd/', 'http://api/v1/hooks/rtn-1?key=secret')).toBe(
      'http://agentd/v1/hooks/rtn-1',
    );
    expect(upstreamUrl('http://agentd/', 'http://api/v1/runs?limit=5')).toBe(
      'http://agentd/v1/runs?limit=5',
    );
  });

  it('keeps the Slack install redirect query (code and state are not a caller secret)', () => {
    expect(upstreamUrl('http://agentd/', 'http://api/v1/channels/slack/oauth/callback?code=c&state=s')).toBe(
      'http://agentd/v1/channels/slack/oauth/callback?code=c&state=s',
    );
  });
});
