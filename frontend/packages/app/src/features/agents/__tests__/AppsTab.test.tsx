import { createMockClient } from "@agent-desktop/test-fixtures";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApps, stubResizeObserver } from "../../apps/__tests__/appsTestKit";
import { AppsTab } from "../card/AppsTab";

stubResizeObserver();
afterEach(cleanup);

async function renderTab(agentId: string) {
  const client = createMockClient({ seed: 7 });
  const agent = await client.agents.get(agentId);
  const setAgentApp = vi.spyOn(client.apps, "setAgentApp");
  const setWorkspaceAgent = vi.spyOn(client.apps, "setWorkspaceAgent");
  renderApps(client, "/agents/x", <AppsTab agent={agent} />);
  return { client, agent, setAgentApp, setWorkspaceAgent };
}

const sectionOf = async (title: string): Promise<HTMLElement> => {
  const heading = await screen.findByRole("heading", { name: title });
  return heading.closest("section") as HTMLElement;
};

describe("Agent settings: Apps", () => {
  it("'can use' lists the added work apps with a switch each; the row's switch does not open the dialog", async () => {
    const { agent, setAgentApp } = await renderTab("agent-juno");
    const section = await sectionOf(`${agent.name} can use`);
    expect(await within(section).findByText("Gmail")).toBeTruthy();
    // Added and on by default; Notion is not added so it is not offered here.
    expect(within(section).queryByText("Notion")).toBeNull();
    expect(within(section).getByText("Sign-in expired · sign in again")).toBeTruthy();
    // No inline segmented control or menu under a row any more.
    expect(within(section).queryByRole("combobox")).toBeNull();
    expect(within(section).queryByRole("radio")).toBeNull();

    fireEvent.click(within(section).getByRole("switch", { name: `Gmail for ${agent.name}` }));
    await waitFor(() => expect(setAgentApp).toHaveBeenCalledWith("agent-juno", "gmail", { enabled: false }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a tap on the row opens the app's dialog: the switch and, for an app that changes things, 'When it changes things' as one choice at a time", async () => {
    const { agent, setAgentApp } = await renderTab("agent-juno");
    const section = await sectionOf(`${agent.name} can use`);
    fireEvent.click(await within(section).findByText("Gmail"));
    const dialog = await screen.findByRole("dialog", { name: "Gmail" });
    expect(within(dialog).getByRole("switch", { name: `${agent.name} can use Gmail` })).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: /Ask first/u }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(dialog).getByRole("radio", { name: /^Allow/u }));
    await waitFor(() => expect(setAgentApp).toHaveBeenCalledWith("agent-juno", "gmail", { enabled: true, actionsPolicy: "allow" }));
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /^Allow/u }).getAttribute("aria-checked")).toBe("true"));
  });

  it("'where people reach' shows the workspaces the agent is in with its @handle, and Add for the ones it is not in", async () => {
    const juno = await renderTab("agent-juno");
    const reach = await sectionOf(`Where people reach ${juno.agent.name}`);
    expect(await within(reach).findByText("@juno")).toBeTruthy();
    expect(within(reach).getByText("Slack · Acme Lab")).toBeTruthy();
    expect(within(reach).getByRole("button", { name: "Add Telegram, Discord… in Apps" })).toBeTruthy();
    cleanup();

    const patch = await renderTab("agent-patch");
    const other = await sectionOf(`Where people reach ${patch.agent.name}`);
    fireEvent.click(await within(other).findByRole("button", { name: `Add ${patch.agent.name}` }));
    await waitFor(() => expect(patch.setWorkspaceAgent).toHaveBeenCalledWith("slack", "inst-slack-1", "agent-patch", { enabled: true }));
  });

  it("a Discord bot made with the agent's own token needs reconnecting: 'Reconnect through the shared app' opens the shared-app install, no token field", async () => {
    const client = createMockClient({ seed: 7 });
    const agent = await client.agents.get("agent-patch");
    const apps = await client.apps.list();
    const discord = apps.find((entry) => entry.id === "discord");
    if (!discord) throw new Error("missing discord");
    const ownBot = { id: "inst-discord-own", appId: "discord", label: "Patch bot", status: "error" as const, agentId: agent.id, agents: [] };
    vi.spyOn(client.apps, "list").mockResolvedValue(apps.map((entry) => (entry.id === "discord" ? { ...discord, installations: [ownBot] } : entry)));
    const install = vi.spyOn(client.apps, "install");
    renderApps(client, "/agents/x", <AppsTab agent={agent} />);
    const reach = await sectionOf(`Where people reach ${agent.name}`);
    expect(await within(reach).findByText("Reconnect through the shared app")).toBeTruthy();
    fireEvent.click(within(reach).getByRole("button", { name: "Reconnect" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(/token|secret/iu)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /own bot/iu })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("discord", { mode: "oauth" }));
  });
});
