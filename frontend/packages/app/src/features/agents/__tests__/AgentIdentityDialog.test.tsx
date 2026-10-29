import type { Agent, ApiClient } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { AgentIdentityDialog } from "../AgentIdentityDialog";

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
  render(<AgentIdentityDialog agent={agent} open onOpenChange={() => {}} readOnly={false} />, { wrapper });
  return queryClient;
}

describe("AgentIdentityDialog", () => {
  it("saves the identity files as home files with the hash they were loaded with", async () => {
    const { client, agent } = await seedAgent();
    const writes: Array<{ path: string; expectedHash?: string }> = [];
    const recording: ApiClient = {
      ...client,
      home: {
        ...client.home,
        write: async (path, input) => {
          writes.push({ path, ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash }) });
          return client.home.write(path, input);
        },
      },
    };
    renderForm(recording, agent);
    const persona = (await client.home.list(`agents/${agent.id}/`)).files.find((f) => f.path.endsWith("IDENTITY.md"));
    await waitFor(() => expect((screen.getByLabelText("Persona") as HTMLTextAreaElement).value).toBe(persona?.content));
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "Calm." } });
    fireEvent.change(screen.getByLabelText("Principles & tone"), { target: { value: "Never swears." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(writes).toEqual([
        { path: `agents/${agent.id}/IDENTITY.md`, expectedHash: persona?.hash },
        { path: `agents/${agent.id}/SOUL.md` },
      ]),
    );
    const files = (await client.home.list(`agents/${agent.id}/`)).files;
    expect(files.find((f) => f.path.endsWith("SOUL.md"))?.content).toBe("Never swears.");
  });

  it("reloads a file changed elsewhere and tells the user", async () => {
    const { client, agent } = await seedAgent();
    renderForm(client, agent);
    const path = `agents/${agent.id}/IDENTITY.md`;
    const persona = (await client.home.list(path)).files[0];
    await waitFor(() => expect((screen.getByLabelText("Persona") as HTMLTextAreaElement).value).toBe(persona?.content));

    fireEvent.change(screen.getByLabelText("Persona"), { target: { value: "My edit." } });
    await client.home.write(path, { content: "Someone else's edit." });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Persona changed elsewhere"));
    await waitFor(() => expect((screen.getByLabelText("Persona") as HTMLTextAreaElement).value).toBe("Someone else's edit."));
  });
});
