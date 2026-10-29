/**
 * A skill's detail sheet: a skill whose tool changed shows the review notice and "Turn on" re-activates its version; a rollback
 * with no earlier version says so (409); and a save the server refuses (422 SKILL_INVALID) shows the server's reason.
 */
import type { ApiClient, Skill, SkillVersion } from "@agent-desktop/client";
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

function version(n: number, status: SkillVersion["status"]): SkillVersion {
  return {
    id: `ver-${n}`,
    skillId: "skl-1",
    version: n,
    status,
    name: "Weekly scan",
    description: "Scan competitors",
    instructions: "Do the scan.",
    deps: [{ type: "tool", name: "web_search", schemaHash: "hash-1" }],
    origin: "manual",
    used: 0,
    helpful: 0,
    harmful: 0,
    lastUsedAt: null,
    createdAt: NOW,
  };
}

function skillWith(active: SkillVersion): Skill {
  return { id: "skl-1", scope: "owner", agentId: null, active, createdAt: NOW };
}

function renderSkills(client: ApiClient, skill: Skill, history: SkillVersion[]): void {
  vi.spyOn(client.skills, "list").mockResolvedValue({ items: [skill], nextCursor: null });
  vi.spyOn(client.skills, "versions").mockResolvedValue(history);
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

async function openSheet(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Weekly scan" }));
  return screen.findByRole("dialog");
}

describe("skill versions", () => {
  it("shows the review notice for a skill whose tool changed, and Turn on activates that version", async () => {
    const client = createMockClient({ seed: 1 });
    const review = version(2, "review");
    renderSkills(client, skillWith(review), [review, version(1, "retired")]);
    const activate = vi.spyOn(client.skills, "activate").mockResolvedValue(skillWith({ ...review, status: "active" }));

    const sheet = await openSheet();
    expect(within(sheet).getByText("A tool this skill uses changed. Review and turn it back on.")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Turn on" }));

    await waitFor(() => expect(activate).toHaveBeenCalledWith("skl-1", 2));
  });

  it("says there is no earlier version when a rollback answers 409", async () => {
    const client = createMockClient({ seed: 1 });
    const first = version(1, "active");
    renderSkills(client, skillWith(first), [first]);
    const rollback = vi
      .spyOn(client.skills, "rollback")
      .mockRejectedValue(Object.assign(new Error("No earlier version."), { status: 409, code: "SKILL_NO_PREVIOUS_VERSION" }));

    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "Roll back" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Roll back" }));

    await waitFor(() => expect(rollback).toHaveBeenCalledWith("skl-1"));
    expect((await screen.findByRole("alert")).textContent).toContain("There is no earlier version to roll back to.");
  });

  it("shows the server's reason when a save is refused as invalid, and keeps the tools the skill uses", async () => {
    const client = createMockClient({ seed: 1 });
    const first = version(1, "active");
    renderSkills(client, skillWith(first), [first]);
    const update = vi
      .spyOn(client.skills, "update")
      .mockRejectedValue(Object.assign(new Error("Instructions cannot grant approval."), { status: 422, code: "SKILL_INVALID" }));

    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "Save as new version" }));

    expect((await within(sheet).findByRole("alert")).textContent).toContain("Instructions cannot grant approval.");
    expect(update.mock.calls[0]?.[1]).toMatchObject({ name: "Weekly scan", deps: [{ type: "tool", name: "web_search" }] });
  });
});
