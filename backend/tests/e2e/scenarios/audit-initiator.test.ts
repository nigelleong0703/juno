import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, scriptModel, scriptedChat, toolCall } from '../harness/client';

interface AuditRow {
  runId?: string;
  decision: string;
  initiator: { type: string; routineId?: string; conversationId?: string };
  unattended: boolean;
}

/**
 * Who started the work (audit initiator): an "ask" rule pauses two runs on the same tool, one the owner started by typing and one a
 * routine started on its schedule. Both approvals are audited; the routine's rows say unattended with the routine as the initiator,
 * the owner's say "you", the filters tell them apart, and the CSV export carries both.
 */
describe('audit initiator', () => {
  it('records unattended routine work and owner-started work, filters them and exports both', async () => {
    const account = await createAccount('audit-initiator');
    const events = await listenEvents(account.cookie);
    try {
      const agent = await account.api('POST', '/v1/agents', { name: 'Careful' });
      expect(agent.status).toBe(201);
      const rule = await account.api('POST', '/v1/rules', {
        description: 'Ask before listing agents', scope: 'action', behavior: 'ask', subject: 'agent_directory', enabled: true,
      });
      expect(rule.status).toBeLessThan(300);

      // The owner types; the run pauses on the rule and the owner approves.
      const { conversationId: ownerChat } = await scriptedChat(account, agent.body.id, [
        { toolCalls: [toolCall('call-dir', 'agent_directory')] },
        { text: `OWNER-${randomUUID().slice(0, 8)}` },
      ], 'who else is on the team?');
      const ownerAsk = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === ownerChat, 30_000);
      const ownerRunId: string = ownerAsk.data.request.runId;
      expect((await account.api('POST', `/v1/requests/${ownerAsk.data.request.id}/resolve`, { action: 'approve' })).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.outcome?.type === 'success' && e.data.metadata.juno.run.id === ownerRunId, 30_000);

      // A routine fires on its schedule into its own chat; nobody is there, the run pauses on the same rule.
      const chat = await account.api('POST', '/v1/conversations', { kind: 'direct', memberAgentIds: [agent.body.id] });
      expect(chat.status).toBe(201);
      const routineChat: string = chat.body.id;
      scriptModel(`${agent.body.id}:${routineChat}`, [
        { toolCalls: [toolCall('call-dir-2', 'agent_directory')] },
        { text: `ROUTINE-${randomUUID().slice(0, 8)}` },
      ]);
      const routine = await account.api('POST', '/v1/routines', {
        name: 'Daily digest', agentId: agent.body.id, instructions: 'list the team', enabled: true,
        trigger: { kind: 'schedule', cron: '*/5 * * * * *', human: 'every 5 seconds', tz: 'UTC' },
        delivery: { channel: 'chat', target: routineChat }, notify: { mode: 'never' },
      });
      expect(routine.status).toBe(201);
      const routineAsk = await events.waitFor((e) => e.data.type === 'request.created' && e.data.request.conversationId === routineChat, 40_000);
      const routineRunId: string = routineAsk.data.request.runId;
      expect((await account.api('POST', `/v1/routines/${routine.body.id}/toggle`, { enabled: false })).status).toBeLessThan(300);
      expect((await account.api('POST', `/v1/requests/${routineAsk.data.request.id}/resolve`, { action: 'approve' })).status).toBe(200);
      await events.waitFor((e) => e.data.type === 'RUN_FINISHED' && e.data.outcome?.type === 'success' && e.data.metadata.juno.run.id === routineRunId, 30_000);

      const rowsOf = async (query: string): Promise<AuditRow[]> => (await account.api('GET', '/v1/audit?action=tool.policy&' + query)).body.items;
      const routineRows = await rowsOf('runId=' + routineRunId);
      expect(routineRows.map((row) => row.decision).sort()).toEqual(['approved', 'asked']);
      for (const row of routineRows) {
        expect(row.unattended).toBe(true);
        expect(row.initiator).toMatchObject({ type: 'routine', routineId: routine.body.id });
      }
      const ownerRows = await rowsOf('runId=' + ownerRunId);
      expect(ownerRows.map((row) => row.decision).sort()).toEqual(['approved', 'asked']);
      for (const row of ownerRows) {
        expect(row.unattended).toBe(false);
        expect(row.initiator).toMatchObject({ type: 'owner_message', conversationId: ownerChat });
      }

      // The run rows carry the same origin.
      const run = await account.api('GET', `/v1/runs/${routineRunId}`);
      expect(run.body.origin).toMatchObject({ type: 'routine', routineId: routine.body.id });
      expect(run.body.routineId).toBe(routine.body.id);

      // Filters: unattended work is only the routine's; "attended" only the owner's.
      expect((await rowsOf('unattended=true')).every((row) => row.initiator.type === 'routine')).toBe(true);
      expect((await rowsOf('unattended=true')).map((row) => row.runId)).toEqual(expect.arrayContaining([routineRunId]));
      expect((await rowsOf('unattended=false')).some((row) => row.runId === routineRunId)).toBe(false);
      expect((await rowsOf('initiator=owner_message')).map((row) => row.runId)).toContain(ownerRunId);
      expect((await rowsOf('initiator=owner_message')).some((row) => row.runId === routineRunId)).toBe(false);

      // The CSV export has both runs' rows with their initiator and unattended columns.
      const csv = await account.api('GET', '/v1/audit/export.csv');
      expect(csv.status).toBe(200);
      const lines = String(csv.body).split('\r\n');
      expect(lines[0]).toBe('at,agent,action,target,decision,reason,rule,initiator,unattended,runId,requestId');
      expect(lines.some((line) => line.includes(',routine,true,' + routineRunId))).toBe(true);
      expect(lines.some((line) => line.includes(',owner_message,false,' + ownerRunId))).toBe(true);
      const onlyUnattended = String((await account.api('GET', '/v1/audit/export.csv?unattended=true')).body);
      expect(onlyUnattended).toContain(',routine,true,' + routineRunId);
      expect(onlyUnattended).not.toContain(',owner_message,');
    } finally {
      events.close();
    }
  });
});
