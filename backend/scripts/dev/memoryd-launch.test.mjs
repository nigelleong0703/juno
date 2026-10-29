import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORYD_TOKEN_BYTES, memorydLaunch } from './memoryd-launch.mjs';

/** A stand-in for crypto.randomBytes: the byte count it was asked for, as hex. */
const fakeHex = (bytes) => 'ab'.repeat(bytes);

describe('memorydLaunch', () => {
  it('generates a per-launch token when MEMORYD_TOKEN is unset, and says so', () => {
    const launch = memorydLaunch({}, fakeHex);
    assert.equal(launch.generated, true);
    assert.equal(launch.token, 'ab'.repeat(MEMORYD_TOKEN_BYTES));
    assert.equal(launch.token.length, 64);
  });

  it('keeps a pinned MEMORYD_TOKEN and does not generate one', () => {
    const launch = memorydLaunch({ MEMORYD_TOKEN: 'pinned-token-value' }, () => {
      throw new Error('must not generate when pinned');
    });
    assert.equal(launch.generated, false);
    assert.equal(launch.token, 'pinned-token-value');
  });

  it('treats an empty MEMORYD_TOKEN as unset', () => {
    const launch = memorydLaunch({ MEMORYD_TOKEN: '' }, fakeHex);
    assert.equal(launch.generated, true);
  });

  it('defaults the URL to the memoryd port on loopback', () => {
    assert.equal(memorydLaunch({}, fakeHex).url, 'http://127.0.0.1:8796');
    assert.equal(memorydLaunch({ MEMORYD_PORT: '9001' }, fakeHex).url, 'http://127.0.0.1:9001');
  });

  it('keeps an explicit MEMORYD_URL', () => {
    assert.equal(memorydLaunch({ MEMORYD_URL: 'http://10.0.0.5:8796' }, fakeHex).url, 'http://10.0.0.5:8796');
  });
});
