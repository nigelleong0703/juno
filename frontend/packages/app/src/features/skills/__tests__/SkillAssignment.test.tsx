/**
 * The Skills page assigns a skill to eligible agents as one batch: it only offers same-workspace,
 * owner-editable agents, persists adds and removes, survives out-of-order responses, and keeps the
 * user's draft with the dialog open when part of the batch fails.
 */
import type { Agent, ApiClient, Skill } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { createWebPlatform } from "../../../platform";
import { SkillsPage } from "../SkillsPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const NOW = new Date().toISOString();

const skill: Skill = {
  id: "skl-1",
  scope: "owner",
  agentId: null,
  createdAt: NOW,
  active: {
    id: "ver-1",
    skillId: "skl-1",
    version: 1,
    status: "active",
    name: "Weekly scan",
    description: "Scan competitors",
    instructions: "Do the scan.",
    deps: [],
    origin: "manual",
    used: 0,
    helpful: 0,
    harmful: 0,
    lastUsedAt: null,
    createdAt: NOW,
  },
};

function agentDoc(id: string, name: string, skillIds: string[]): Agent {
  return {
    id,
    name,
    handle: id,
    avatar: { shape: "circle", color: 1, eyes: "dot" },
    title: "Agent",
    status: "idle",
    section: "Agents",
    pinned: false,
    lastActivity: NOW,
    unreadCount: 0,
    channels: [],
    macAccess: false,
    skillIds,
    pluginIds: [],
    sharing: { publishedToTeam: false },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function renderPage(client: ApiClient): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={queryClient} platform={createWebPlatform()}>
      <MemoryRouter initialEntries={["/skills"]}>{children}</MemoryRouter>
    </ClientProvider>
  );
  render(<SkillsPage />, { wrapper });
}

function deferredAgent() {
  let settle: (value: Agent) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<Agent>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return { promise, settle: (value: Agent) => settle(value), fail: (error: unknown) => fail(error) };
}

function seed(client: ApiClient, agents: Agent[]): void {
  vi.spyOn(client.skills, "list").mockResolvedValue({ items: [skill], nextCursor: null });
  vi.spyOn(client.agents, "list").mockResolvedValue({ items: agents, nextCursor: null });
}

async function openAssignment(agent: Agent): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Assign" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("checkbox", { name: agent.name })).toBeDefined();
  return dialog;
}

describe("SkillsPage agent assignment", () => {
  it("assigns a skill to an unselected agent and persists the new skillIds", async () => {
    const client = createMockClient({ seed: 1 });
    const free = agentDoc("agent-1", "Nova", []);
    seed(client, [free]);
    const update = vi.spyOn(client.agents, "update").mockResolvedValue({ ...free, skillIds: [skill.id] });
    renderPage(client);

    const dialog = await openAssignment(free);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Nova" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]).toEqual(["agent-1", { skillIds: [skill.id] }]);
  });

  it("removes the skill from an already-assigned agent", async () => {
    const client = createMockClient({ seed: 1 });
    const assigned = agentDoc("agent-2", "Orion", [skill.id]);
    seed(client, [assigned]);
    const update = vi.spyOn(client.agents, "update").mockResolvedValue({ ...assigned, skillIds: [] });
    renderPage(client);

    const dialog = await openAssignment(assigned);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Orion" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]).toEqual(["agent-2", { skillIds: [] }]);
  });

  it("waits for the whole batch and keeps the draft when part of it fails", async () => {
    const client = createMockClient({ seed: 1 });
    const nova = agentDoc("agent-1", "Nova", []);
    const vega = agentDoc("agent-2", "Vega", []);
    seed(client, [nova, vega]);
    const novaResult = deferredAgent();
    const vegaResult = deferredAgent();
    const update = vi
      .spyOn(client.agents, "update")
      .mockImplementation((id) => (id === "agent-1" ? novaResult.promise : vegaResult.promise));
    renderPage(client);

    const dialog = await openAssignment(nova);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Nova" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Vega" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("button", { name: "Saving…" })).toBeDefined();
    novaResult.settle({ ...nova, skillIds: [skill.id] });
    vegaResult.fail(new Error("forbidden"));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDefined());
    const stillOpen = screen.getByRole("dialog");
    expect(within(stillOpen).getByRole("checkbox", { name: "Nova" }).getAttribute("aria-checked")).toBe("true");
  });

  it("settles out-of-order responses and closes on full success", async () => {
    const client = createMockClient({ seed: 1 });
    const nova = agentDoc("agent-1", "Nova", []);
    const vega = agentDoc("agent-2", "Vega", []);
    seed(client, [nova, vega]);
    const novaResult = deferredAgent();
    const vegaResult = deferredAgent();
    const update = vi
      .spyOn(client.agents, "update")
      .mockImplementation((id) => (id === "agent-1" ? novaResult.promise : vegaResult.promise));
    renderPage(client);

    const dialog = await openAssignment(nova);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Nova" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Vega" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    vegaResult.settle({ ...vega, skillIds: [skill.id] });
    novaResult.settle({ ...nova, skillIds: [skill.id] });

    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls).toEqual([
      ["agent-1", { skillIds: [skill.id] }],
      ["agent-2", { skillIds: [skill.id] }],
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows a load-more control when the page reports more skills", async () => {
    const client = createMockClient({ seed: 1 });
    const list = vi
      .spyOn(client.skills, "list")
      .mockResolvedValueOnce({ items: [skill], nextCursor: "cursor-2" })
      .mockResolvedValueOnce({ items: [{ ...skill, id: "skl-2", active: skill.active && { ...skill.active, name: "Older scan" } }], nextCursor: null });
    vi.spyOn(client.agents, "list").mockResolvedValue({ items: [], nextCursor: null });
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Load more skills" }));
    expect(await screen.findByText("Older scan")).toBeDefined();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
