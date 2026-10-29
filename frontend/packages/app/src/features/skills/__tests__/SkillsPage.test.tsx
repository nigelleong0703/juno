/** The new-skill dialog creates a personal skill and surfaces a rejected create to the user. */
import type { ApiClient, Skill } from "@agent-desktop/client";
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
const createdSkill: Skill = {
  id: "skl-test",
  scope: "owner",
  agentId: null,
  createdAt: NOW,
  active: {
    id: "ver-test",
    skillId: "skl-test",
    version: 1,
    status: "active",
    name: "Weekly scan",
    description: "",
    instructions: "Scan.",
    deps: [],
    origin: "manual",
    used: 0,
    helpful: 0,
    harmful: 0,
    lastUsedAt: null,
    createdAt: NOW,
  },
};

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

async function openDialogAndName(name: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByPlaceholderText("e.g. Weekly competitor scan"), {
    target: { value: name },
  });
  return dialog;
}

describe("SkillsPage create", () => {
  it("keeps create disabled until named and sends a personal skill", async () => {
    const client = createMockClient({ seed: 1 });
    const createSpy = vi.spyOn(client.skills, "create").mockResolvedValue(createdSkill);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    const dialog = await screen.findByRole("dialog");
    const createButton = within(dialog).getByRole("button", { name: "Create skill" });
    expect(createButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(within(dialog).getByPlaceholderText("e.g. Weekly competitor scan"), {
      target: { value: "Weekly scan" },
    });
    expect(createButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(createButton);

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0]?.[0]).toMatchObject({ name: "Weekly scan", deps: [] });
  });

  it("shows a rejected create to the user", async () => {
    const client = createMockClient({ seed: 1 });
    vi.spyOn(client.skills, "create").mockRejectedValue(new Error("Skill name already exists"));
    renderPage(client);

    const dialog = await openDialogAndName("Rejected skill");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create skill" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Skill name already exists");
  });
});
