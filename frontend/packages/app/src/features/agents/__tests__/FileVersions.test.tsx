/**
 * "Versions" under an opened file-write step (BACKEND 5.2d): the kept earlier versions, newest first, Restore after a question.
 */
import type { FileSnapshot, Step } from "@agent-desktop/client";
import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { FileVersions } from "../card/FileVersions";

afterEach(cleanup);

const PATH = "/workspace/report.md";

const step = (extra: Partial<Step> = {}): Step => ({
  id: "s1", runId: "r1", index: 0, kind: "file", verb: "Executed", target: "files.write", tool: "files.write",
  input: { summary: JSON.stringify({ path: PATH, content: "new" }) }, status: "completed", startedAt: "2026-11-01T10:00:00.000Z", durationMs: 5, ...extra,
});

const snapshot = (n: number): FileSnapshot => ({
  id: `snap-${n}`, agentId: "a1", path: PATH, on: "sandbox", tool: "files.write", sizeBytes: 100 * n, sha256: `h${n}`,
  createdAt: new Date(Date.UTC(2026, 10, 1, 8, n)).toISOString(),
});

function renderVersions(client: MockClient, shown: Step = step()) {
  return render(
    <ClientProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <FileVersions step={shown} agentId="a1" />
        </TooltipProvider>
      </ThemeProvider>
    </ClientProvider>,
  );
}

describe("File versions", () => {
  it("shows nothing when no earlier version is kept, or for a step that is not a file write", async () => {
    const client = createMockClient({ seed: 3 });
    const view = renderVersions(client);
    await waitFor(() => expect(client.delivery.snapshots).toHaveLength(0));
    expect(screen.queryByRole("button", { name: "Versions" })).toBeNull();
    view.unmount();
    client.delivery.snapshots.push(snapshot(1));
    renderVersions(client, step({ tool: "web_search", target: "web_search" }));
    expect(screen.queryByRole("button", { name: "Versions" })).toBeNull();
  });

  it("lists versions newest first, five at a time", async () => {
    const client = createMockClient({ seed: 3 });
    client.delivery.snapshots.push(...[1, 2, 3, 4, 5, 6, 7].map(snapshot));
    renderVersions(client);
    fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
    const sizes = () => within(screen.getByRole("list", { name: "Versions" })).getAllByText(/B$/u).map((node) => node.textContent);
    expect(sizes()).toEqual(["700 B", "600 B", "500 B", "400 B", "300 B"]);
    fireEvent.click(screen.getByRole("button", { name: /Show more/u }));
    expect(sizes()).toHaveLength(7);
  });

  it("asks before restoring, then restores that version and keeps the current one as a new version", async () => {
    const client = createMockClient({ seed: 3 });
    client.delivery.snapshots.push(snapshot(1), snapshot(2));
    renderVersions(client);
    fireEvent.click(await screen.findByRole("button", { name: "Versions" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Restore" })[0] as HTMLElement);
    expect(await screen.findByText("Restore this version?")).toBeTruthy();
    expect(screen.getByText("The current version is kept, so you can undo this.")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(client.delivery.snapshots).toHaveLength(3));
    expect(client.delivery.snapshots[2]).toMatchObject({ tool: "files.restore", restoredFrom: "snap-2" });
  });
});
