import type { Agent, AgentEvent, Conversation, Run } from "@agent-desktop/client";
import { EventType } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { qk } from "../keys";
import { applyEvent, resetLiveState } from "../liveSync";

let qc: QueryClient;

beforeEach(() => {
  qc = new QueryClient();
});

async function fixtures(): Promise<{ agent: Agent; conversation: Conversation }> {
  const client = createMockClient({ seed: 5 });
  const agent = (await client.agents.list()).items[0];
  const conversation = (await client.conversations.list()).items[0];
  if (!agent || !conversation) throw new Error("missing fixtures");
  return { agent, conversation };
}

async function seedCache(): Promise<{ agent: Agent; conversation: Conversation }> {
  const client = createMockClient({ seed: 5 });
  const agents = (await client.agents.list()).items;
  const conversations = (await client.conversations.list()).items;
  const agent = agents[0];
  const conversation = conversations[0];
  if (!agent || !conversation) throw new Error("missing fixtures");
  qc.setQueryData(qk.agents(), agents);
  qc.setQueryData(qk.agent(agent.id), agent);
  qc.setQueryData(qk.conversations(), conversations);
  qc.setQueryData(qk.conversation(conversation.id), conversation);
  qc.setQueryData(qk.items(conversation.id), []);
  return { agent, conversation };
}

function conversationIds(): string[] {
  const list = qc.getQueryData<Conversation[]>(qk.conversations()) ?? [];
  return list.map((entry) => entry.id);
}

function agentRows(): string[] {
  const list = qc.getQueryData<Agent[]>(qk.agents()) ?? [];
  return list.map((entry) => entry.id);
}

describe("UI108 delete tombstones", () => {
  it("conversation.deleted removes the row and drops its cached detail and items", async () => {
    const { conversation } = await seedCache();
    const before = conversationIds();
    expect(before).toContain(conversation.id);
    const deleted: AgentEvent = { type: "conversation.deleted", conversationId: conversation.id };
    applyEvent(qc, deleted);
    expect(conversationIds()).toEqual(before.filter((id) => id !== conversation.id));
    expect(qc.getQueryData(qk.conversation(conversation.id))).toBeUndefined();
    expect(qc.getQueryData(qk.items(conversation.id))).toBeUndefined();
  });

  it("agent.deleted removes the agent row and its cached detail", async () => {
    const { agent } = await seedCache();
    const before = agentRows();
    expect(before).toContain(agent.id);
    const deleted: AgentEvent = { type: "agent.deleted", agentId: agent.id };
    applyEvent(qc, deleted);
    expect(agentRows()).toEqual(before.filter((id) => id !== agent.id));
    expect(qc.getQueryData(qk.agent(agent.id))).toBeUndefined();
  });

  it("replaying created then deleted leaves no ghost row", async () => {
    const { agent, conversation } = await fixtures();
    qc.setQueryData(qk.agents(), []);
    qc.setQueryData(qk.conversations(), []);
    const created: AgentEvent = { type: "conversation.created", conversation };
    const conversationDeleted: AgentEvent = {
      type: "conversation.deleted",
      conversationId: conversation.id,
    };
    const agentDeleted: AgentEvent = { type: "agent.deleted", agentId: agent.id };
    applyEvent(qc, created);
    expect(conversationIds()).toContain(conversation.id);
    applyEvent(qc, conversationDeleted);
    applyEvent(qc, agentDeleted);
    expect(conversationIds()).not.toContain(conversation.id);
    expect(qc.getQueryData(qk.conversation(conversation.id))).toBeUndefined();
    expect(qc.getQueryData(qk.items(conversation.id))).toBeUndefined();
  });

  it("conversation.updated replaces a cached row but never resurrects a deleted one", async () => {
    const { conversation } = await seedCache();
    const updated: AgentEvent = { type: "conversation.updated", conversation: { ...conversation, muted: true } };
    applyEvent(qc, updated);
    const rows = qc.getQueryData<Conversation[]>(qk.conversations()) ?? [];
    expect(rows.find((c) => c.id === conversation.id)?.muted).toBe(true);
    applyEvent(qc, { type: "conversation.deleted", conversationId: conversation.id });
    applyEvent(qc, updated);
    expect(conversationIds()).not.toContain(conversation.id);
    expect(qc.getQueryData(qk.conversation(conversation.id))).toBeUndefined();
  });

  it("H-93: a finished run leaves status-filtered run lists but stays in unfiltered ones", () => {
    const base: Run = {
      id: "run-1", agentId: "agent-1", conversationId: "conv-1", title: "t", status: "running", kind: "chat", steps: [],
      usage: { inputTokens: 0, outputTokens: 0, computeSeconds: 0, costUsd: 0, steps: 0 },
      startedAt: "2026-10-09T00:00:00.000Z", lastActivityAt: "2026-10-09T00:00:00.000Z",
    };
    qc.setQueryData(qk.runs({ conversationId: "conv-1", status: "running" }), [base]);
    qc.setQueryData(qk.runs({ conversationId: "conv-1" }), [base]);
    applyEvent(qc, {
      type: EventType.RUN_FINISHED,
      threadId: "conv-1",
      runId: "run-1",
      outcome: { type: "cancelled" },
      metadata: { juno: { runId: "run-1", conversationId: "conv-1" } },
    });
    expect(qc.getQueryData<Run[]>(qk.runs({ conversationId: "conv-1", status: "running" }))).toEqual([]);
    expect(qc.getQueryData<Run[]>(qk.runs({ conversationId: "conv-1" }))?.[0]?.status).toBe("stopped");
  });
});

describe("F-08 / F-11 home live data", () => {
  it("agent.status replaces the live line with the snapshot and clears it once the agent stops working", async () => {
    const { agent } = await seedCache();
    applyEvent(qc, { type: "agent.status", agentId: agent.id, status: "working", doing: "Reviewing PR #214" });
    expect(qc.getQueryData<Agent>(qk.agent(agent.id))?.doing).toBe("Reviewing PR #214");
    expect(qc.getQueryData<Agent[]>(qk.agents())?.find((entry) => entry.id === agent.id)?.doing).toBe("Reviewing PR #214");
    applyEvent(qc, { type: "agent.status", agentId: agent.id, status: "idle" });
    expect(qc.getQueryData<Agent>(qk.agent(agent.id))?.status).toBe("idle");
    expect(qc.getQueryData<Agent>(qk.agent(agent.id))).not.toHaveProperty("doing");
  });

  it("idea.updated joins an open list while open and leaves it once accepted or dismissed", () => {
    const open = { id: "idea-1", agentId: "agent-1", text: "t", prompt: "p", status: "open", createdAt: "x", updatedAt: "x" } as const;
    qc.setQueryData(qk.ideas({ status: "open" }), []);
    applyEvent(qc, { type: "idea.updated", idea: open });
    expect(qc.getQueryData<unknown[]>(qk.ideas({ status: "open" }))).toHaveLength(1);
    applyEvent(qc, { type: "idea.updated", idea: { ...open, status: "dismissed" } });
    expect(qc.getQueryData<unknown[]>(qk.ideas({ status: "open" }))).toEqual([]);
  });
});

describe("housekeeping runs", () => {
  it("a background run from live sync never enters the runs cache", async () => {
    const client = createMockClient({ seed: 5 });
    const base = (await client.runs.list()).items[0];
    if (!base) throw new Error("missing run fixture");
    qc.setQueryData(qk.runs(), []);
    applyEvent(qc, {
      type: EventType.CUSTOM,
      name: "juno.run.updated",
      value: { ...base, id: "bg-run", kind: "background" },
      metadata: { juno: { runId: "bg-run", conversationId: base.conversationId! } },
    });
    expect(qc.getQueryData<Run[]>(qk.runs())).toEqual([]);
    applyEvent(qc, {
      type: EventType.CUSTOM,
      name: "juno.run.updated",
      value: { ...base, id: "chat-run", kind: "chat" },
      metadata: { juno: { runId: "chat-run", conversationId: base.conversationId! } },
    });
    expect(qc.getQueryData<Run[]>(qk.runs())?.map((r) => r.id)).toEqual(["chat-run"]);
  });
});

describe("helper links", () => {
  it("a helper starting adds itself to the already-cached parent's child ids", async () => {
    const client = createMockClient({ seed: 5 });
    const base = (await client.runs.list()).items[0];
    if (!base) throw new Error("missing run fixture");
    qc.setQueryData(qk.run("parent"), { ...base, id: "parent" });
    const child = { ...base, id: "child-1", kind: "background", parentRunId: "parent" } as Run;
    applyEvent(qc, {
      type: EventType.CUSTOM,
      name: "juno.run.updated",
      value: child,
      metadata: { juno: { runId: child.id, conversationId: "conv-1" } },
    });
    expect(qc.getQueryData<Run>(qk.run("parent"))?.childRunIds).toEqual(["child-1"]);
  });
});

describe("AG-UI transcript projection", () => {
  const conversationId = "conv-agui";
  const at = "2026-10-29T00:00:00.000Z";

  function metadata(runId = "run-agui") {
    return { juno: { conversationId, agentId: "agent-juno", runId } };
  }

  function committedMessage(markdown: string): AgentEvent {
    return {
      type: "item.added",
      conversationId,
      item: {
        id: "msg-authoritative",
        conversationId,
        at,
        type: "agent_message",
        agentId: "agent-juno",
        runId: "run-agui",
        markdown,
        citations: [],
      },
    };
  }

  it("projects append-only standard text once and replaces it with the authoritative item by id", () => {
    applyEvent(qc, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-authoritative",
      role: "assistant",
      metadata: metadata(),
    });
    applyEvent(qc, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-authoritative", delta: "Hel", metadata: metadata() });
    applyEvent(qc, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-authoritative", delta: "lo", metadata: metadata() });
    applyEvent(qc, { type: EventType.TEXT_MESSAGE_END, messageId: "msg-authoritative", metadata: metadata() });
    expect(qc.getQueryData<unknown[]>(qk.items(conversationId))).toHaveLength(1);
    expect(qc.getQueryData<Array<{ markdown?: string }>>(qk.items(conversationId))?.[0]?.markdown).toBe("Hello");

    applyEvent(qc, committedMessage("Hello"));
    const items = qc.getQueryData<Array<{ id: string; markdown?: string }>>(qk.items(conversationId));
    expect(items).toHaveLength(1);
    expect(items?.[0]).toMatchObject({ id: "msg-authoritative", markdown: "Hello" });
  });

  it("keeps a stopped preview closed but still accepts committed text as its own item", () => {
    applyEvent(qc, {
      type: EventType.RUN_FINISHED,
      threadId: conversationId,
      runId: "run-agui",
      outcome: { type: "cancelled" },
      metadata: metadata(),
    });
    applyEvent(qc, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-after-stop",
      metadata: metadata(),
    });
    applyEvent(qc, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "msg-after-stop", delta: "late", metadata: metadata() });
    applyEvent(qc, { type: EventType.TEXT_MESSAGE_END, messageId: "msg-after-stop", metadata: metadata() });
    expect(qc.getQueryData<Array<{ id: string; markdown?: string }>>(qk.items(conversationId))).toEqual([
      expect.objectContaining({ id: "msg-after-stop", markdown: "late" }),
    ]);
  });

  it("rebuilds the transcript from MESSAGES_SNAPSHOT without duplicate rows", () => {
    applyEvent(qc, {
      type: EventType.MESSAGES_SNAPSHOT,
      metadata: { juno: { conversationId } },
      messages: [
        { id: "m-user", role: "user", content: "question", metadata: { juno: { authorId: "usr-1", item: {
          id: "m-user", conversationId, at, type: "user_message", authorId: "usr-1", text: "question", attachments: [], mentions: [],
        } } } },
        { id: "m-agent", role: "assistant", content: "answer", metadata: metadata() },
        { id: "m-agent", role: "assistant", content: "answer", metadata: metadata() },
      ],
    });
    const items = qc.getQueryData<Array<{ id: string }>>(qk.items(conversationId));
    expect(items?.map((item) => item.id).sort()).toEqual(["m-agent", "m-user"]);
  });

  it("merges a snapshot without deleting older pages or an optimistic placeholder", () => {
    // A snapshot row without its own item is stamped now, so the other rows are placed relative to the clock.
    const optimistic = {
      id: "optimistic-pending",
      conversationId,
      at: new Date(Date.now() + 60_000).toISOString(),
      type: "user_message" as const,
      authorId: "usr-1",
      text: "still sending",
      attachments: [],
      mentions: [],
    };
    const older = {
      id: "older-page",
      conversationId,
      at: new Date(Date.now() - 86_400_000).toISOString(),
      type: "system" as const,
      level: "info" as const,
      text: "loaded earlier",
    };
    qc.setQueryData(qk.items(conversationId), [older, optimistic]);
    applyEvent(qc, {
      type: EventType.MESSAGES_SNAPSHOT,
      metadata: { juno: { conversationId } },
      messages: [{ id: "snapshot-row", role: "assistant", content: "restored", metadata: metadata() }],
    });
    expect(qc.getQueryData<Array<{ id: string }>>(qk.items(conversationId))?.map((item) => item.id)).toEqual([
      "older-page",
      "snapshot-row",
      "optimistic-pending",
    ]);
  });

  it("isolates identical message ids in different conversations and ignores a replay after END", () => {
    const apply = (event: AgentEvent) => applyEvent(qc, event);
    const metaFor = (conversation: string) => ({ juno: { conversationId: conversation, agentId: "agent-juno", runId: "run-" + conversation } });
    apply({ type: EventType.TEXT_MESSAGE_START, messageId: "same", metadata: metaFor("conv-a") });
    apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "same", delta: "A", metadata: metaFor("conv-a") });
    apply({ type: EventType.TEXT_MESSAGE_START, messageId: "same", metadata: metaFor("conv-b") });
    apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "same", delta: "B", metadata: metaFor("conv-b") });
    apply({ type: EventType.TEXT_MESSAGE_START, messageId: "same", metadata: metaFor("conv-a") });
    apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "same", delta: " replay", metadata: metaFor("conv-a") });
    apply({ type: EventType.TEXT_MESSAGE_END, messageId: "same", metadata: metaFor("conv-a") });
    apply({ type: EventType.TEXT_MESSAGE_END, messageId: "same", metadata: metaFor("conv-b") });
    apply({ type: EventType.TEXT_MESSAGE_START, messageId: "same", metadata: metaFor("conv-a") });
    apply({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "same", delta: "again", metadata: metaFor("conv-a") });
    apply({ type: EventType.TEXT_MESSAGE_END, messageId: "same", metadata: metaFor("conv-a") });
    expect(qc.getQueryData<Array<{ markdown?: string }>>(qk.items("conv-a"))?.[0]?.markdown).toBe("A replay");
    expect(qc.getQueryData<Array<{ markdown?: string }>>(qk.items("conv-b"))).toHaveLength(1);
    expect(qc.getQueryData<Array<{ markdown?: string }>>(qk.items("conv-b"))?.[0]?.markdown).toBe("B");
    expect(qc.getQueryData<Array<{ markdown?: string }>>(qk.items("conv-a"))).toHaveLength(1);
  });

  it("resets the query cache before a cursor replay", () => {
    qc.setQueryData(qk.items(conversationId), []);
    resetLiveState(qc);
    expect(qc.getQueryData(qk.items(conversationId))).toBeUndefined();
  });
});
