import type { ApiClient } from "@agent-desktop/client";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { qk } from "../../../data/keys";
import type { ScreenRefItem as ScreenRefData } from "../../../lib/items";
import { useUiStore } from "../../../store/ui";
import { ScreenRefItem } from "../ScreenRefItem";

afterEach(cleanup);

const item: ScreenRefData = { type: "screen_ref", id: "i1", conversationId: "c1", at: "2026-11-02T08:00:00.000Z", agentId: "a1", runId: "r1", url: "https://news.example.com/a" };

function renderCard(status: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  queryClient.setQueryData(qk.run("r1"), { id: "r1", status });
  render(
    <ClientProvider client={{} as ApiClient} queryClient={queryClient}>
      <ScreenRefItem item={item} />
    </ClientProvider>,
  );
}

describe("ScreenRefItem", () => {
  it("is Live with the current page while the run works, and a tap opens the live screen pane", () => {
    useUiStore.getState().setComputerPanelOpen(false);
    renderCard("running");
    expect(screen.getByText("Live · news.example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(useUiStore.getState().computerPanelOpen).toBe(true);
  });

  it("reads Ended with the last page after the run finished, and a tap opens the last frame instead of the pane", () => {
    useUiStore.getState().setComputerPanelOpen(false);
    renderCard("completed");
    expect(screen.getByText("Ended · last page news.example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(useUiStore.getState().computerPanelOpen).toBe(false);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
