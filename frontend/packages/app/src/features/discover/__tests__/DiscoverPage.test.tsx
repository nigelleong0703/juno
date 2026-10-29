import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { webPlatform } from "../../../platform";
import { TEMPLATES } from "../../new-agent/NewAgentTemplateDialog";
import { DiscoverPage } from "../DiscoverPage";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});
afterEach(cleanup);

function renderDiscover(client: MockClient) {
  render(
    <MemoryRouter initialEntries={["/discover"]}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <ClientProvider client={client} platform={webPlatform} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <DiscoverPage />
          </ClientProvider>
        </TooltipProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe("Discover skills", () => {
  it("Add asks which agent should get the skill, then adds it to that agent's skill ids", async () => {
    const base = createMockClient({ seed: 7 });
    const [skill] = (await base.skills.list({ limit: 20 })).items;
    const [agent] = await base.agents.list().then((page) => page.items);
    if (!skill || !agent) throw new Error("the mock world has no skill or agent");
    const updates: string[] = [];
    renderDiscover({
      ...base,
      agents: {
        ...base.agents,
        update: async (id, patch) => {
          updates.push(`${id}:${(patch.skillIds ?? []).join(",")}`);
          return base.agents.update(id, patch);
        },
      },
    });

    fireEvent.click((await screen.findAllByRole("button", { name: "Add" }))[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(`Add ${skill.active?.name ?? ""}`)).toBeTruthy();
    fireEvent.click((await within(dialog).findAllByRole("radio"))[0] as HTMLElement);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(updates.length).toBe(1));
    // The chosen agent is sent its skill ids with this skill added.
    expect(updates[0]).toContain(skill.id);
  });
});

describe("Discover agents", () => {
  const [first, second] = TEMPLATES;
  if (!first || !second) throw new Error("fewer than two templates");

  it("the featured template is not listed again under it", async () => {
    renderDiscover(createMockClient({ seed: 7 }));
    expect(await screen.findAllByText(`${first.name} · ${first.title}`)).toHaveLength(1);
    expect(screen.getAllByText(`${second.name} · ${second.title}`)).toHaveLength(1);
  });

  it("search narrows the templates by name, role and blurb", async () => {
    renderDiscover(createMockClient({ seed: 7 }));
    fireEvent.change(await screen.findByPlaceholderText("Search agents and skills"), { target: { value: second.name.toLowerCase() } });
    await waitFor(() => expect(screen.queryByText(`${first.name} · ${first.title}`)).toBeNull());
    expect(screen.getByText(`${second.name} · ${second.title}`)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Search agents and skills"), { target: { value: "zzzz-no-such" } });
    await waitFor(() => expect(screen.queryByText(`${second.name} · ${second.title}`)).toBeNull());
  });
});
