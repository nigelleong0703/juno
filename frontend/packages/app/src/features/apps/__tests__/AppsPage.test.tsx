import { createMockClient } from "@agent-desktop/test-fixtures";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderApps, stubResizeObserver } from "./appsTestKit";

stubResizeObserver();
afterEach(cleanup);

const rowNames = () => screen.getAllByRole("button").map((button) => button.textContent ?? "");

describe("Apps page", () => {
  it("opens on Connected with the apps that are added, and says Sign in where a sign-in expired", async () => {
    renderApps(createMockClient({ seed: 7 }), "/apps");
    const calendar = await screen.findByRole("button", { name: /Google Calendar/u });
    expect(calendar.textContent).toMatch(/Sign in/u);
    const gmail = screen.getByRole("button", { name: /Gmail/u });
    expect(gmail.textContent).not.toMatch(/Sign in/u);
    expect(screen.getByRole("button", { name: /Slack/u })).toBeTruthy();
    // Not added: not in this pill (the featured banner has its own Add button, so look for rows by their blurb).
    expect(screen.queryByText("Search and work with your pages")).toBeNull();
    expect(rowNames().some((name) => name.startsWith("Discord"))).toBe(false);
  });

  it("filters by category pill and lists Web & video, Coming soon only where it needs a sign-in", async () => {
    renderApps(createMockClient({ seed: 7 }), "/apps");
    await screen.findByRole("button", { name: /Gmail/u });

    fireEvent.click(screen.getByRole("radio", { name: "Chat" }));
    expect(await screen.findByRole("button", { name: /Discord/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Telegram/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Gmail/u })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Work" }));
    const notion = await screen.findByRole("button", { name: /Notion/u });
    expect(notion.textContent).not.toMatch(/Coming soon/u);

    fireEvent.click(screen.getByRole("radio", { name: "Web & video" }));
    const locked = await screen.findByRole("button", { name: /Xiaohongshu/u });
    expect(locked.textContent).toMatch(/Coming soon/u);
    const open = screen.getByRole("button", { name: /YouTube videos.*Read video transcripts/u });
    expect(open.textContent).not.toMatch(/Coming soon/u);
  });

  it("searches across every category and opens an app's page from its row", async () => {
    renderApps(createMockClient({ seed: 7 }), "/apps");
    await screen.findByRole("button", { name: /Gmail/u });
    fireEvent.change(screen.getByPlaceholderText("Search apps"), { target: { value: "notion" } });
    const row = await screen.findByRole("button", { name: /Notion/u });
    expect(screen.queryByRole("button", { name: /Gmail/u })).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/apps/notion"));
    expect(await screen.findByRole("heading", { name: "Notion" })).toBeTruthy();
    expect(within(document.body).getByRole("button", { name: "Connect" })).toBeTruthy();
  });
});
