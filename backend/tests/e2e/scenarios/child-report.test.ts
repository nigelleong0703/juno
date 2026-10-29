import { aguiInput } from '../../agui-input.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptModel, toolCall, waitForTranscript } from '../harness/client';

/**
 * H-71: a child task sends its parent a mid-run progress report with report_to_parent. The parent
 * session receives it as an untrusted hand_back (a report, not an instruction), then the child's
 * final result as one task_done.
 */
describe('child report to parent', () => {
  it('delivers a mid-run report and then the final result to the parent session', async () => {
    const account = await createAccount('child-report');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Lead' });
      expect(agent.status).toBe(201);
      const progress = `PROGRESS-${randomUUID().slice(0, 8)}`;
      // Every child of this chat follows this script: report once, then finish.
      const created = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(created.status).toBe(201);
      const conversationId: string = created.body.id;
      scriptModel(`${agent.body.id}:${conversationId}::child:*`, [
        { toolCalls: [toolCall('call-report', 'report_to_parent', { text: progress })] },
        { text: 'child finished the research' },
      ]);
      const sessionKey = `${agent.body.id}:${conversationId}`;
      scriptModel(sessionKey, [
        { toolCalls: [toolCall('call-spawn', 'child_spawn', { prompt: 'research and report progress', notify: true })] },
        { text: 'on it' }, { text: 'noted' }, { text: 'noted' }, { text: 'noted' },
      ]);
      const sent = await account.api('POST', `/v1/conversations/${conversationId}/runs`, aguiInput(`/v1/conversations/${conversationId}/runs`, { text: 'please research' }));
      expect(sent.status).toBe(202);

      const transcript = await waitForTranscript(sessionKey, (m) =>
        m.some((t) => t.includes('[update from your child task')) && m.some((t) => t.includes('[background task finished')),
      );
      const reports = transcript.filter((t) => t.includes('[update from your child task'));
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain(`<untrusted>${progress}</untrusted>`);
      const completions = transcript.filter((t) => t.includes('[background task finished'));
      expect(completions).toHaveLength(1);
      expect(completions[0]).toContain('child finished the research');
    } finally {
      events.close();
    }
  });
});
