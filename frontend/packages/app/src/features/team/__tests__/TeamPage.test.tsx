import { createMockClient } from "@agent-desktop/test-fixtures";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderTeam, stubResizeObserver } from "./teamTestKit";

stubResizeObserver();
afterEach(cleanup);

describe("Team page", () => {
  it("the segment control moves between Agents, People and Memory in the route", async () => {
    renderTeam(createMockClient({ seed: 7 }), "/team/agents");
    await screen.findByRole("button", { name: "New agent" });
    fireEvent.click(screen.getByText("People"));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/team/people"));
    fireEvent.click(screen.getByText("Memory"));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/team/memory"));
  });

  it("People says Coming soon while its route answers 404, and Memory says it is unavailable on 503", async () => {
    const base = createMockClient({ seed: 7 });
    const notShipped = Object.assign(new Error("Not found"), { status: 404 });
    const unavailable = Object.assign(new Error("Memory is down"), { status: 503 });
    renderTeam(
      {
        ...base,
        people: { ...base.people, list: () => Promise.reject(notShipped) },
        memoryItems: { ...base.memoryItems, list: () => Promise.reject(unavailable) },
      },
      "/team/people",
    );
    expect(await screen.findByText("Coming soon")).toBeTruthy();
    fireEvent.click(screen.getByText("Memory"));
    expect(await screen.findByText("Memory is unavailable right now.")).toBeTruthy();
  });

  it("an agent row shows a real role and hides the placeholder 'New agent'", async () => {
    const base = createMockClient({ seed: 7 });
    const [first, second] = (await base.agents.list()).items;
    if (!first || !second) throw new Error("the mock world has fewer than two agents");
    renderTeam(
      {
        ...base,
        agents: {
          ...base.agents,
          list: async () => ({ items: [{ ...first, title: "Market research" }, { ...second, title: "New agent" }], nextCursor: null }),
        },
      },
      "/team/agents",
    );
    expect(await screen.findByText("Market research")).toBeTruthy();
    expect(screen.getByText(second.name)).toBeTruthy();
    // The "+" in the top bar is an icon with a name only; no row carries the placeholder.
    expect(screen.queryByText("New agent")).toBeNull();
  });

  it("the agents are open on the page: no card container, no New agent row, no Goals row", async () => {
    renderTeam(createMockClient({ seed: 7 }), "/team/agents");
    await screen.findByRole("button", { name: "New agent" });
    const rows = await within(screen.getByRole("list", { name: "Agents" })).findAllByRole("button");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Neither the row nor the list item around it draws a border or a fill.
      for (const element of [row, row.parentElement as HTMLElement]) {
        expect(element.className).not.toMatch(/\b(border|bg-muted|bg-card|shadow)/);
      }
    }
    expect(screen.queryByRole("button", { name: /^Goals/ })).toBeNull();
  });

  it("the header counts the agents working now", async () => {
    const base = createMockClient({ seed: 7 });
    const [first, second] = (await base.agents.list()).items;
    if (!first || !second) throw new Error("the mock world has fewer than two agents");
    renderTeam(
      {
        ...base,
        agents: { ...base.agents, list: async () => ({ items: [{ ...first, status: "working" }, { ...second, status: "idle" }], nextCursor: null }) },
      },
      "/team/agents",
    );
    expect(await screen.findByText("Your team")).toBeTruthy();
    expect(await screen.findByText(/^1 working now/)).toBeTruthy();
  });

  it("New agent opens the compose route", async () => {
    renderTeam(createMockClient({ seed: 7 }), "/team/agents");
    fireEvent.click(await screen.findByRole("button", { name: "New agent" }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/new"));
  });
});
