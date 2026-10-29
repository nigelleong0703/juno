import type { Agent, ApiClient, Id, UpdateAgentInput } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { qk } from "../../../data/keys";
import { agentCharacter } from "../../../lib/avatars";
import { AgentEditDialog } from "../AgentProfileForm";

afterEach(() => cleanup());

async function seedAgent(): Promise<{ client: ApiClient; agent: Agent }> {
  const client = createMockClient({ seed: 3 });
  const agent = await client.agents.get("agent-juno");
  return { client, agent };
}

function renderForm(client: ApiClient, agent: Agent): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientProvider client={client} queryClient={queryClient}>
      {children}
    </ClientProvider>
  );
  render(<AgentEditDialog agent={agent} open onOpenChange={() => {}} readOnly={false} />, { wrapper });
  return queryClient;
}

describe("AgentEditDialog", () => {
  it("shows the current name and role with save disabled while pristine", async () => {
    const { client, agent } = await seedAgent();
    renderForm(client, agent);

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(agent.name);
    expect((screen.getByLabelText("Role") as HTMLInputElement).value).toBe(agent.title);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves only the changed fields, avatar included, and refreshes the agent cache", async () => {
    const { client, agent } = await seedAgent();
    const seen: UpdateAgentInput[] = [];
    const recording: ApiClient = {
      ...client,
      agents: {
        ...client.agents,
        update: async (id: Id, patch: UpdateAgentInput) => {
          seen.push(patch);
          return client.agents.update(id, patch);
        },
      },
    };
    const queryClient = renderForm(recording, agent);

    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "Night-shift triage" } });
    const other = agentCharacter(agent.id, agent.avatar) === "mint" ? "blue" : "mint";
    fireEvent.click(screen.getByRole("radio", { name: other === "mint" ? "Mint" : "Blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(seen).toEqual([{ title: "Night-shift triage", avatar: { ...agent.avatar, character: other } }]));
    const persisted = await client.agents.get(agent.id);
    expect(persisted.title).toBe("Night-shift triage");
    expect(persisted.avatar?.character).toBe(other);
    expect(persisted.name).toBe(agent.name);
    await waitFor(() => expect(queryClient.getQueryData<Agent>(qk.agent(agent.id))?.title).toBe("Night-shift triage"));
  });

  it("keeps the draft on screen when the update fails", async () => {
    const { client, agent } = await seedAgent();
    const failing: ApiClient = {
      ...client,
      agents: {
        ...client.agents,
        update: async (): Promise<Agent> => {
          throw new Error("update failed");
        },
      },
    };
    renderForm(failing, agent);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Juno II" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Juno II");
  });

  it("blocks save with an inline error when the name is blank", async () => {
    const { client, agent } = await seedAgent();
    const seen: UpdateAgentInput[] = [];
    const recording: ApiClient = {
      ...client,
      agents: {
        ...client.agents,
        update: async (id: Id, patch: UpdateAgentInput) => {
          seen.push(patch);
          return client.agents.update(id, patch);
        },
      },
    };
    renderForm(recording, agent);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
    // Live validation flags the blank name at once and keeps save disabled, so no update is ever sent.
    expect(screen.getByText("Name is required.")).toBeDefined();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect(seen).toEqual([]);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Juno II" } });
    expect(screen.queryByText("Name is required.")).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
