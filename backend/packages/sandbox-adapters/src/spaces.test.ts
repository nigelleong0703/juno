import { describe, expect, it } from 'vitest';
import { listenerProblem, parseListeners } from './spaces.js';

// Header, a loopback listener of uid 1001 on 7100 (0x1BBC), an all-interfaces listener of uid 1002 on 7101, a connected socket (state 01) and an IPv6 loopback one.
const TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:1BBC 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 11111 1 0000000000000000 100 0 0 10 0',
  '   1: 00000000:1BBD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 22222 1 0000000000000000 100 0 0 10 0',
  '   2: 0100007F:C350 0100007F:1BBC 01 00000000:00000000 00:00000000 00000000  1001        0 33333 1 0000000000000000 20 4 30 10 -1',
].join('\n');
const TCP6 = [
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 00000000000000000000000001000000:1BBE 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 44444 1 0000000000000000 100 0 0 10 0',
].join('\n');

describe('parseListeners', () => {
  it('reads listening sockets with their owner and whether they are loopback-only, and ignores the rest', () => {
    expect(parseListeners(TCP + '\n' + TCP6)).toEqual([
      { port: 7100, uid: 1001, loopback: true },
      { port: 7101, uid: 1002, loopback: false },
      { port: 7102, uid: 1001, loopback: true },
    ]);
  });
});

describe('listenerProblem', () => {
  const mine = { port: 7100, uid: 1001, loopback: true };
  it('accepts only the agent\'s own loopback listener', () => {
    expect(listenerProblem(7100, [mine], 1001)).toBeUndefined();
    expect(listenerProblem(7100, [], 1001)).toContain('nothing is listening on port 7100');
    expect(listenerProblem(7100, [mine], 1002)).toContain('not this agent\'s');
    expect(listenerProblem(7100, [mine, { ...mine, uid: 1002 }], 1001)).toContain('not this agent\'s');
    expect(listenerProblem(7100, [{ ...mine, loopback: false }], 1001)).toContain('127.0.0.1 only');
  });
});
