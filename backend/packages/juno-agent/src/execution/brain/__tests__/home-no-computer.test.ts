// BACKEND 5.3: building a context never contacts the computer; the home is the mirror as it stands.
import { expect, it } from 'vitest';
import { buildContext } from '../context.js';
import { AGENT, conversationDoc, seed, wakeFor } from './agent-resources.fixtures.js';
import { newRow, putRow } from '../../../modules/home/mirror.js';
import { agentFilePath } from '../../../modules/home/paths.js';
import type { HomeComputer } from '../../../ports/computer/index.js';
import { contextText } from './context-text.js';

it('reads the mirror and makes no computer call, passive or active', async () => {
  const store = await seed();
  await store.patch('agents', AGENT, { createdBy: 'owner-1' });
  await store.put('conversations', conversationDoc('c1', [AGENT]) as never);
  await putRow(store, newRow('owner-1', agentFilePath(AGENT, 'SOUL.md'), 'MIRROR-PRINCIPLES', 'user', '2026-10-12T00:00:00.000Z'));
  const calls: string[] = [];
  const touched = async (): Promise<never> => { calls.push('call'); throw new Error('the context build reached the computer'); };
  const face: HomeComputer = { snapshot: touched, read: touched, write: touched, putFile: touched, extractText: touched, delete: touched, ensure: touched };
  const home: HomeComputer = { ...face, whileRunning: () => face };
  const ctx = await buildContext(store, {
    agentId: AGENT, conversationId: 'c1', sessionKey: AGENT + ':c1', home: { home },
    wake: [{ ...wakeFor(AGENT), conversationId: 'c1', sessionKey: AGENT + ':c1', origin: { type: 'user', id: 'owner-1' }, trusted: true }],
  });
  expect(calls).toEqual([]);
  expect(contextText(ctx)).toContain('MIRROR-PRINCIPLES');
});
