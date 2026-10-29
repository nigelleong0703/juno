import type { Agent, ApiClient, Conversation } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../auth/AuthContext";
import { ClientProvider } from "../../../data/ClientProvider";
import { AgentSettingsPage } from "../AgentSettingsPage";
import { AgentProfile } from "../card/AgentProfile";
import { useUiStore } from "../../../store/ui";
import { AgentPane } from "../pane/AgentPane";
import { AgentPanelPopover } from "../pane/AgentPanel";

// The live screen needs a real stream and layout; the surfaces around them do not.
vi.mock("../../../components/computer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../components/computer")>()),
  ComputerPane: () => <div data-testid="computer-pane" />,
}));

afterEach(() => {
  cleanup();
  useUiStore.setState({ agentPanelAnchor: null, workspaceTab: "computer", workspaceAgentId: null });
});

/**
 * Production has no `PlannedFeaturesProvider` (only the prototype passes `planned`), so these render
 * exactly what a live account sees: no planned context, no planned data. `userId` is the signed-in
 * person; agents created by someone else are read-only for them.
 */
function wrap(client: ApiClient, ui: ReactNode, route = "/", userId = "member-robin") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <AuthContext.Provider
          value={{ mode: "account", user: { id: userId, name: "Robin", email: "n@example.com", initials: "N" }, signOut: () => {} }}
        >
          <ClientProvider client={client} queryClient={queryClient}>
            <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
          </ClientProvider>
        </AuthContext.Provider>
      </TooltipProvider>
    </ThemeProvider>,
  );
}

async function seed(): Promise<{ client: ApiClient; agent: Agent; conversation: Conversation }> {
  const client = createMockClient({ seed: 3 });
  const agent = await client.agents.get("agent-juno");
  const conversation = (await client.conversations.list()).items.find((item) => item.agentIds.includes(agent.id));
  if (!conversation) throw new Error("mock world has no conversation with agent-juno");
  return { client, agent, conversation };
}

/** The panel's icon tabs are a single-select toggle group (radios named by tooltip text). */
function openTab(name: string | RegExp) {
  fireEvent.click(screen.getByRole("radio", { name }));
}

/** Pick an option of a tier's menu (Radix Select opens on a key press in jsdom). */
async function chooseTier(label: string, option: string) {
  Element.prototype.scrollIntoView = () => {};
  fireEvent.keyDown(await screen.findByLabelText(label), { key: "Enter" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("production agent surfaces (no planned provider)", () => {
  it("renders the agent panel with its identity and the five management tabs", async () => {
    const { client, agent } = await seed();
    // No creator on record: the signed-in person may edit it.
    wrap(client, <AgentProfile agent={{ ...agent, createdBy: undefined }} />);

    expect(await screen.findByRole("heading", { name: agent.name, level: 2 })).toBeDefined();
    const names = screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"));
    expect(names).toEqual(["Activity", "Permissions", "Apps", "Automations", "Memory"]);
    // The pencil opens the Edit agent dialog; the identity files sit behind the Memory tab.
    fireEvent.click(screen.getByRole("button", { name: "Edit agent" }));
    expect(await screen.findByLabelText("Name")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    openTab("Memory");
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText("Working instructions")).toBeDefined();
  });

  it("saves an identity change from the pencil, and shows others' agents read-only", async () => {
    const { client, agent } = await seed();
    wrap(client, <AgentProfile agent={{ ...agent, createdBy: undefined }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit agent" }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Juno the Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await client.agents.get(agent.id)).name).toBe("Juno the Second"));
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
    cleanup();

    wrap(client, <AgentProfile agent={{ ...agent, createdBy: "member-someone-else" }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit agent" }));
    expect(screen.getByText(/Only the person who created this agent/)).toBeDefined();
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    // The identity files say so too, and cannot be edited.
    wrap(client, <AgentProfile agent={{ ...agent, createdBy: "member-someone-else" }} />);
    openTab("Memory");
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Only the person who created this agent can edit its identity.")).toBeDefined();
    expect((screen.getByLabelText("Persona") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("shows the workspace (Computer | Files, the agent's tasks under the screen) and opens management from the name", async () => {
    const { client, agent, conversation } = await seed();
    useUiStore.getState().openWorkspace();
    wrap(client, <AgentPane agentId={agent.id} conversationId={conversation.id} />);

    expect(await screen.findByTestId("computer-pane")).toBeDefined();
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("aria-label") ?? radio.textContent)).toEqual(["Computer", "Files"]);
    expect(screen.queryByRole("heading", { name: agent.name, level: 2 })).toBeNull();

    // Files shows inline and keeps the live screen mounted (hidden).
    fireEvent.click(screen.getByRole("radio", { name: "Files" }));
    expect(await screen.findByRole("button", { name: /Open in Library/ })).toBeDefined();
    expect(screen.getByTestId("computer-pane").parentElement?.parentElement?.hasAttribute("hidden")).toBe(true);

    // The header's name opens the management dropdown: the profile with its four tabs, no Computer.
    fireEvent.click(screen.getByRole("button", { name: `Manage ${agent.name}` }));
    expect(await screen.findByRole("heading", { name: agent.name, level: 2 })).toBeDefined();
    const dropdown = document.querySelector<HTMLElement>("[data-slot=popover-content]");
    if (!dropdown) throw new Error("management dropdown not open");
    expect(within(dropdown).getAllByRole("radio").map((radio) => radio.getAttribute("aria-label"))).toEqual(["Activity", "Permissions", "Apps", "Automations", "Memory"]);
  });

  it("picks whose computer the workspace shows in a group chat", async () => {
    const client = createMockClient({ seed: 3 });
    const room = (await client.conversations.list()).items.find((item) => item.kind === "room" && item.agentIds.length > 1);
    if (!room) throw new Error("mock world has no group chat");
    const [first, second] = await Promise.all(room.agentIds.slice(0, 2).map((id) => client.agents.get(id)));
    if (!first || !second) throw new Error("group members missing");
    useUiStore.getState().openWorkspace(first.id);
    wrap(client, <AgentPane agentId={first.id} conversationId={room.id} />);

    const picker = await screen.findByRole("button", { name: "Choose whose computer to show" });
    expect(picker.textContent).toContain(first.name);
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("button", { name: second.name }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Choose whose computer to show" }).textContent).toContain(second.name));
    expect(useUiStore.getState().workspaceAgentId).toBe(second.id);
  });

  it("lists the members of a group chat in the dropdown and opens one member's panel, with a way back", async () => {
    const client = createMockClient({ seed: 3 });
    const room = (await client.conversations.list()).items.find((item) => item.kind === "room" && item.agentIds.length > 1);
    if (!room) throw new Error("mock world has no group chat");
    const [first, second] = await Promise.all(room.agentIds.slice(0, 2).map((id) => client.agents.get(id)));
    if (!first || !second) throw new Error("group members missing");
    wrap(client, <AgentPanelPopover anchor="header" conversationId={room.id}><button type="button">Show members</button></AgentPanelPopover>);

    fireEvent.click(screen.getByRole("button", { name: "Show members" }));
    fireEvent.click(await screen.findByText(second.name));
    expect(await screen.findByRole("heading", { name: second.name, level: 2 })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Members" }));
    expect(await screen.findByText(`@${second.handle}`)).toBeDefined();
  });

  it("saves a tier through the agent update, and disables tiers for non-owners", async () => {
    const { client, agent } = await seed();
    const update = vi.fn(client.agents.update);
    const recording: ApiClient = { ...client, agents: { ...client.agents, update } };
    const owned = { ...agent, createdBy: "member-robin" };
    wrap(recording, <AgentProfile agent={owned} />);

    openTab("Permissions");
    await chooseTier("Reaching out", "Off");
    await waitFor(() => expect(update).toHaveBeenCalledWith(agent.id, { permissionTiers: { reachOut: "off" } }));
  });

  it("turns on Mac access only once a Mac is paired, and says when it is offline", async () => {
    const { client, agent } = await seed();
    const update = vi.fn(client.agents.update);
    const recording: ApiClient = { ...client, agents: { ...client.agents, update } };
    wrap(recording, <AgentProfile agent={{ ...agent, macAccess: false, createdBy: "member-robin" }} />);

    openTab("Permissions");
    // Nothing paired: the switch is there but cannot be flipped, and says why.
    expect(((await screen.findByRole("switch", { name: "Can use your Mac" })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Connect your Mac in Settings first.")).toBeDefined();
    cleanup();

    await client.computers.pairMyMac({ name: "Test Mac" });
    wrap(recording, <AgentProfile agent={{ ...agent, macAccess: false, createdBy: "member-robin" }} />);
    openTab("Permissions");
    await waitFor(() => expect((screen.getByRole("switch", { name: "Can use your Mac" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("switch", { name: "Can use your Mac" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(agent.id, { macAccess: true }));
    cleanup();

    // The agent may use the Mac and the Mac's link is down: the switch says so.
    (client as ReturnType<typeof createMockClient>).setMyMacOnline(false);
    wrap(recording, <AgentProfile agent={{ ...agent, macAccess: true, createdBy: "member-robin" }} />);
    openTab("Permissions");
    expect(await screen.findByText("Your Mac is offline. Open Juno on it so this agent can use it again.")).toBeDefined();
  });

  it("shows permission tiers read-only to someone else", async () => {
    const { client, agent } = await seed();
    wrap(client, <AgentProfile agent={{ ...agent, createdBy: "member-someone-else" }} />, "/", "member-robin");

    openTab("Permissions");
    expect(((await screen.findByLabelText("Browsing")) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the agent panel on the agent page", async () => {
    const { client, agent } = await seed();
    wrap(
      client,
      <Routes>
        <Route path="/agents/:agentId/settings/:section?" element={<AgentSettingsPage />} />
      </Routes>,
      `/agents/${agent.id}/settings/profile`,
    );

    expect(await screen.findByRole("heading", { name: agent.name, level: 2 })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Memory" })).toBeDefined();
  });
});
