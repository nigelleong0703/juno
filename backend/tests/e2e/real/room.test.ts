import { aguiInput } from '../../agui-input.js';
import { describe, expect, it } from 'vitest';
import { createAccount, listenEvents, listItems, listRuns, toolActivity, waitForToolActivity, type Account, type EventListener } from '../harness/client';

/**
 * Group chat with a real model (product form B): the user is in the room, an @mention wakes the
 * mentioned agent, handoff passes a task to another member, send_message with targetAgentIds wakes
 * the addressed members. Assertions check events, run rows, items and tool calls, never wording.
 */
interface Room {
  account: Account;
  events: EventListener;
  roomId: string;
  agents: Record<'ada' | 'bo' | 'cy', { id: string; name: string }>;
}

async function openRoom(prefix: string): Promise<Room> {
  const account = await createAccount(prefix);
  const events = await listenEvents(account.cookie);
  const makeAgent = async (name: string) => {
    const res = await account.api('POST', '/v1/agents', { name });
    expect(res.status).toBe(201);
    return { id: String(res.body.id), name };
  };
  const agents = { ada: await makeAgent('Ada'), bo: await makeAgent('Bo'), cy: await makeAgent('Cy') };
  const created = await account.api('POST', '/v1/conversations', { kind: 'room', title: 'Team', memberAgentIds: [agents.ada.id, agents.bo.id, agents.cy.id] });
  expect(created.status).toBe(201);
  return { account, events, roomId: created.body.id, agents };
}

function mention(agent: { id: string; name: string }) {
  return { kind: 'agent', id: agent.id, label: `@${agent.name}` };
}

function runFinished(room: Room, agentId: string) {
  return room.events.waitFor(
    (e) => e.data.type === 'RUN_FINISHED' && e.data.metadata.juno.run.conversationId === room.roomId && e.data.metadata.juno.run.agentId === agentId,
    200_000,
  );
}

describe('real model: group chat', () => {
  it('wakes the @mentioned agent and nobody else, and it replies in the room', async () => {
    const room = await openRoom('real-room-b1');
    try {
      const { ada, bo, cy } = room.agents;
      const sent = await room.account.api('POST', `/v1/conversations/${room.roomId}/runs`, aguiInput(`/v1/conversations/${room.roomId}/runs`, {
        text: '@Ada Reply with one short sentence: what is 2 + 3?',
        mentions: [mention(ada)],
      }));
      expect(sent.status).toBe(202);
      const reply = await room.events.waitFor(
        (e) => e.data.type === 'item.added' && e.data.conversationId === room.roomId && e.data.item.type === 'agent_message' && e.data.item.agentId === ada.id,
        200_000,
      );
      const finished = await runFinished(room, ada.id);
      expect(finished.data.metadata.juno.run.status).toBe('completed');
      expect(reply.data.item.runId).toBe(finished.data.metadata.juno.run.id);
      const runs = await listRuns(room.account, room.roomId);
      expect(runs.filter((run) => run.agentId === bo.id || run.agentId === cy.id)).toHaveLength(0);
    } finally {
      room.events.close();
    }
  });

  it('hands a task off to another agent in the room, who then acts', async () => {
    const room = await openRoom('real-room-b2');
    try {
      const { ada, bo, cy } = room.agents;
      const sent = await room.account.api('POST', `/v1/conversations/${room.roomId}/runs`, aguiInput(`/v1/conversations/${room.roomId}/runs`, {
        text:
          `@Ada This task belongs to Bo, not you. Call the handoff tool exactly once with roomId "${room.roomId}", to "${bo.id}" and task ` +
          '"Greet the room with one short sentence." Do not do the task yourself and do not use any other tool for it.',
        mentions: [mention(ada)],
      }));
      expect(sent.status).toBe(202);
      await room.events.waitFor((e) => e.data.type === 'item.added' && e.data.conversationId === room.roomId && e.data.item.type === 'handoff', 200_000);
      const boReply = await room.events.waitFor(
        (e) => e.data.type === 'item.added' && e.data.conversationId === room.roomId && e.data.item.type === 'agent_message' && e.data.item.agentId === bo.id,
        200_000,
      );
      const boFinished = await runFinished(room, bo.id);
      expect(boFinished.data.metadata.juno.run.status).toBe('completed');
      expect(boReply.data.item.runId).toBeTruthy();

      const handoffs = (await toolActivity(`${ada.id}:${room.roomId}`)).calls.filter((call) => call.name === 'handoff');
      expect(handoffs.length).toBeGreaterThanOrEqual(1);
      expect(handoffs[0]?.arguments['to']).toBe(bo.id);
      const runs = await listRuns(room.account, room.roomId);
      expect(runs.filter((run) => run.agentId === cy.id)).toHaveLength(0);
    } finally {
      room.events.close();
    }
  });

  it('wakes the addressed agents when send_message carries targetAgentIds', async () => {
    const room = await openRoom('real-room-b3');
    try {
      const { ada, bo, cy } = room.agents;
      const sent = await room.account.api('POST', `/v1/conversations/${room.roomId}/runs`, aguiInput(`/v1/conversations/${room.roomId}/runs`, {
        text:
          `@Ada Please tell Bo and Cy that stand-up starts in five minutes. They are in this room with us, so notify them with one send_message call: ` +
          `kind "text", text "Stand-up in five minutes.", conversationId "${room.roomId}", targetAgentIds ["${bo.id}", "${cy.id}"]. A plain reply would not reach them, only that call does.`,
        mentions: [mention(ada)],
      }));
      expect(sent.status).toBe(202);
      // Ada's own run first, so a missed tool call fails with what she actually did instead of a bare timeout.
      await runFinished(room, ada.id);
      const activity = await waitForToolActivity(`${ada.id}:${room.roomId}`, (a) => a.calls.length > 0)
        .catch(async (error: Error) => { throw new Error(error.message + ' items: ' + JSON.stringify((await listItems(room.account, room.roomId)).filter((i) => i.type === 'agent_message'))); });
      const targeted = activity.calls.filter((call) => call.name === 'send_message' && Array.isArray(call.arguments['targetAgentIds']));
      expect(targeted.length, JSON.stringify(activity)).toBeGreaterThanOrEqual(1);
      const started = (agentId: string) =>
        room.events.waitFor(
          (e) => e.data.type === 'RUN_STARTED' && e.data.metadata.juno.run.conversationId === room.roomId && e.data.metadata.juno.run.agentId === agentId,
          200_000,
        );
      await Promise.all([started(bo.id), started(cy.id)]);
      const [boDone, cyDone] = await Promise.all([runFinished(room, bo.id), runFinished(room, cy.id)]);
      expect(boDone.data.metadata.juno.run.status).toBe('completed');
      expect(cyDone.data.metadata.juno.run.status).toBe('completed');

      const items = await listItems(room.account, room.roomId);
      expect(items.some((item) => item.type === 'agent_message' && item.agentId === ada.id)).toBe(true);
    } finally {
      room.events.close();
    }
  });
});
