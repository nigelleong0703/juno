import type {
  AgentEvent,
  ApiClient,
  EventHandler,
  EventSource,
  PlanItem,
  Todo,
} from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { useLiveSync } from "../../../data/liveSync";
import { tc } from "../i18n";
import { TasksPanel } from "../panels/TasksPanel";

afterEach(cleanup);

function todo(overrides: Partial<Todo> = {}): Todo {
  return { id: "todo-1", text: "Do the thing", status: "pending", ...overrides };
}

function plan(overrides: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "plan-1",
    conversationId: "conv-1",
    at: "2026-10-08T00:00:00.000Z",
    type: "plan",
    runId: "run-1",
    todos: [],
    ...overrides,
  };
}

/** Live client whose `agents.plans` is the single task source under test. */
function taskClient(tasks: () => Promise<PlanItem[]>): ApiClient {
  const base = createMockClient({ seed: 3 });
  const agents: ApiClient["agents"] = {
    ...base.agents,
    plans: async () => ({ items: await tasks(), nextCursor: null }),
  };
  return { ...base, mode: "live", agents };
}

interface EmittingSource extends EventSource {
  emit(event: AgentEvent): void;
}

function eventSource(): EmittingSource {
  const handlers = new Set<EventHandler>();
  return {
    subscribe(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(event) {
      for (const handler of handlers) handler(event);
    },
  };
}

function LivePanel({ agentId }: { agentId: string }) {
  useLiveSync();
  return <TasksPanel agentId={agentId} />;
}

function renderPanel(client: ApiClient, agentId = "agent-juno", events: EventSource | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider defaultTheme="dark">
      <ClientProvider client={client} events={events} queryClient={queryClient}>
        <TasksPanel agentId={agentId} />
      </ClientProvider>
    </ThemeProvider>,
  );
}

describe("Persistent ongoing tasks", () => {
  it("keeps an unfinished todo visible after its run has finished", async () => {
    const client = taskClient(async () => [
      plan({ runId: "run-done", todos: [todo({ text: "Draft the launch note", status: "pending" })] }),
    ]);
    renderPanel(client);

    // The bound run is not consulted: the plan endpoint alone decides what is ongoing.
    await waitFor(() => expect(screen.getByText("Draft the launch note")).toBeTruthy());
    expect(screen.getByText(tc("computer.tasks.status.pending"))).toBeTruthy();
    expect(screen.queryByText(tc("computer.tasks.empty"))).toBeNull();
  });

  it("shows the blocked todo with its reason note", async () => {
    const client = taskClient(async () => [
      plan({
        todos: [
          todo({ id: "t-blocked", text: "Publish the release", status: "blocked", note: "Waiting on the signing key" }),
        ],
      }),
    ]);
    renderPanel(client);

    await waitFor(() => expect(screen.getByText("Publish the release")).toBeTruthy());
    expect(screen.getByText(tc("computer.tasks.status.blocked"))).toBeTruthy();
    expect(screen.getByText("Waiting on the signing key")).toBeTruthy();
  });

  it("hides done todos and keeps the outstanding ones", async () => {
    const client = taskClient(async () => [
      plan({
        todos: [
          todo({ id: "t-done", text: "Finished step", status: "done" }),
          todo({ id: "t-open", text: "Open step", status: "in_progress" }),
        ],
      }),
    ]);
    renderPanel(client);

    await waitFor(() => expect(screen.getByText("Open step")).toBeTruthy());
    expect(screen.getByText(tc("computer.tasks.status.inProgress"))).toBeTruthy();
    expect(screen.queryByText("Finished step")).toBeNull();
  });

  it("filters out plans owned by another agent", async () => {
    const client = taskClient(async () => [
      plan({
        id: "plan-patch",
        conversationId: "conv-patch",
        agentId: "agent-patch",
        todos: [todo({ id: "t-patch", text: "Patch-only work", status: "pending" })],
      }),
      plan({
        id: "plan-juno",
        conversationId: "conv-juno",
        agentId: "agent-juno",
        todos: [todo({ id: "t-juno", text: "Juno work", status: "pending" })],
      }),
    ]);
    renderPanel(client, "agent-juno");

    await waitFor(() => expect(screen.getByText("Juno work")).toBeTruthy());
    expect(screen.queryByText("Patch-only work")).toBeNull();
  });

  it("keeps identical todo ids from two conversations distinct", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = taskClient(async () => [
      plan({
        id: "plan-a",
        conversationId: "conv-a",
        agentId: "agent-juno",
        todos: [todo({ id: "todo-1", text: "First conversation task", status: "pending" })],
      }),
      plan({
        id: "plan-b",
        conversationId: "conv-b",
        agentId: "agent-juno",
        todos: [todo({ id: "todo-1", text: "Second conversation task", status: "in_progress" })],
      }),
    ]);
    renderPanel(client);

    await waitFor(() => expect(screen.getByText("First conversation task")).toBeTruthy());
    expect(screen.getByText("Second conversation task")).toBeTruthy();
    // The row key is scoped by conversation, so React never sees a duplicate key.
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("same key"))).toBe(false);
    errorSpy.mockRestore();
  });

  it("refreshes from a streamed plan item and drops a now-done todo", async () => {
    let plans: PlanItem[] = [
      plan({ todos: [todo({ id: "t-live", text: "Ship the fix", status: "in_progress" })] }),
    ];
    const client = taskClient(async () => plans);
    const events = eventSource();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ThemeProvider defaultTheme="dark">
        <ClientProvider client={client} events={events} queryClient={queryClient}>
          <LivePanel agentId="agent-juno" />
        </ClientProvider>
      </ThemeProvider>,
    );

    await waitFor(() => expect(screen.getByText("Ship the fix")).toBeTruthy());

    const finished = plan({ todos: [todo({ id: "t-live", text: "Ship the fix", status: "done" })] });
    plans = [finished];
    events.emit({ type: "item.added", conversationId: "conv-1", item: finished });

    await waitFor(() => expect(screen.queryByText("Ship the fix")).toBeNull());
    expect(screen.getByText(tc("computer.tasks.empty"))).toBeTruthy();
  });

  it("shows a loading state instead of a false empty list", () => {
    const client = taskClient(() => new Promise<PlanItem[]>(() => {}));
    renderPanel(client);

    expect(screen.getByText(tc("computer.tasks.loading"))).toBeTruthy();
    expect(screen.queryByText(tc("computer.tasks.empty"))).toBeNull();
  });

  it("shows an explicit error instead of a false empty list", async () => {
    const client = taskClient(async () => {
      throw new Error("tasks unavailable");
    });
    renderPanel(client);

    await waitFor(() => expect(screen.getByText(tc("computer.tasks.error"))).toBeTruthy());
    expect(screen.queryByText(tc("computer.tasks.empty"))).toBeNull();
  });

  it("never fabricates tasks from run history", async () => {
    const tasks = vi.fn(async () => ({ items: [] as PlanItem[], nextCursor: null }));
    const base = createMockClient({ seed: 3 });
    const client: ApiClient = { ...base, mode: "live", agents: { ...base.agents, plans: tasks } };
    renderPanel(client);

    await waitFor(() => expect(screen.getByText(tc("computer.tasks.empty"))).toBeTruthy());
    // The seeded live run is active, yet it must never appear as an ongoing task.
    expect(screen.queryByText("Triage the inbox and draft replies")).toBeNull();
    expect(tasks).toHaveBeenCalledWith("agent-juno");
  });
});
