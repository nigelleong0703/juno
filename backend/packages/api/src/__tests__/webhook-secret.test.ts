import { describe, expect, it } from 'vitest';
import { upstreamUrl } from '../proxy.js';
import {
  hashWebhookSecret,
  presentedWebhookSecret,
  webhookSecretMatches,
} from '../modules/webhook-secret.js';

function headers(values: Record<string, string>) {
  return { header: (name: string) => values[name.toLowerCase()] };
}

describe('webhook secret helpers', () => {
  it('prefers X-Hook-Secret, then Bearer, then ?key=', () => {
    expect(presentedWebhookSecret(headers({ 'x-hook-secret': 'a', authorization: 'Bearer b' }), 'c')).toBe('a');
    expect(presentedWebhookSecret(headers({ authorization: 'bearer b' }), 'c')).toBe('b');
    expect(presentedWebhookSecret(headers({}), 'c')).toBe('c');
    expect(presentedWebhookSecret(headers({ authorization: 'Basic xyz' }), undefined)).toBeUndefined();
    expect(presentedWebhookSecret(headers({}), '')).toBeUndefined();
  });

  it('matches only the stored sha256 and fails closed without a valid one', () => {
    const stored = hashWebhookSecret('s3cret').toString('hex');
    expect(webhookSecretMatches('s3cret', stored)).toBe(true);
    expect(webhookSecretMatches('s3cret ', stored)).toBe(false);
    expect(webhookSecretMatches('s3cret', undefined)).toBe(false);
    expect(webhookSecretMatches('s3cret', '')).toBe(false);
    expect(webhookSecretMatches('s3cret', 'zz')).toBe(false);
    expect(webhookSecretMatches('s3cret', stored.slice(0, 32))).toBe(false);
  });

  it('never forwards the query of a webhook call, but keeps it for every other route', () => {
    expect(upstreamUrl('http://agentd/', 'http://api/v1/hooks/rtn-1?key=secret')).toBe('http://agentd/v1/hooks/rtn-1');
    expect(upstreamUrl('http://agentd/', 'http://api/v1/runs?limit=5')).toBe('http://agentd/v1/runs?limit=5');
  });
});
