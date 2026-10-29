/**
 * The dev launcher's memoryd defaults (scripts/dev/backend.mjs). Pure, so the choice is tested without spawning anything.
 *
 * The services themselves still require MEMORYD_TOKEN (memoryd refuses to start without it; agentd refuses MEMORYD_URL without it).
 * This only spares a dev launch from editing .env: when MEMORYD_TOKEN is unset, the launcher makes a random token for this launch and
 * hands the same value to memoryd and agentd. A token generated this way lasts only as long as the launch, so the launcher says so.
 */

export const MEMORYD_DEFAULT_PORT = '8796';
export const MEMORYD_TOKEN_BYTES = 32;

/**
 * `env` is process.env (or a stand-in); `randomHex(bytes)` returns that many random bytes as hex (crypto.randomBytes in the launcher).
 * Returns the token, the URL agentd uses, and whether the token was generated for this launch.
 */
export function memorydLaunch(env, randomHex) {
  const port = env['MEMORYD_PORT'] ?? MEMORYD_DEFAULT_PORT;
  const set = env['MEMORYD_TOKEN'] ?? '';
  const generated = set === '';
  return {
    port,
    token: generated ? randomHex(MEMORYD_TOKEN_BYTES) : set,
    generated,
    url: env['MEMORYD_URL'] || `http://127.0.0.1:${port}`,
  };
}
