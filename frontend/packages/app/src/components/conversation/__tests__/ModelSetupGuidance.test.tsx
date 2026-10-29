import type { ApiClient, Run } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSetupAction } from "../../run/ModelSetupAction";
import { ClientProvider } from "../../../data/ClientProvider";
import { ModelProviderNotice } from "../ModelProviderNotice";

afterEach(cleanup);

function renderAt(client: ApiClient, element: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ClientProvider client={client} queryClient={queryClient}>
      <MemoryRouter initialEntries={["/c/1"]}>
        <Routes>
          <Route path="/c/:id" element={element} />
          <Route path="/settings/models" element={<p>models settings page</p>} />
        </Routes>
      </MemoryRouter>
    </ClientProvider>,
  );
}

describe("model setup guidance", () => {
  it("shows the composer notice only when no run can start, and it opens Models settings", async () => {
    renderAt(createMockClient({ seed: 7, platformDefault: false }), <ModelProviderNotice />);
    expect(await screen.findByText("Add a model provider so your agents can reply")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(await screen.findByText("models settings page")).toBeDefined();
  });

  it("stays out of the way when a default is configured", async () => {
    const client = createMockClient({ seed: 7 });
    renderAt(client, <ModelProviderNotice />);
    await waitFor(async () => expect((await client.modelProviders.list()).usable).toBe(true));
    expect(screen.queryByText("Add a model provider so your agents can reply")).toBeNull();
  });

  it("shows a provider-fixable run failure even when providers are usable, and not once a newer run succeeds", async () => {
    const failed = {
      id: "run-1", kind: "chat", status: "failed", agentId: "a", conversationId: "c", title: "hi", steps: [],
      startedAt: "2026-10-13T10:00:00.000Z",
      usage: { steps: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, computeSeconds: 0 },
      error: "Your model provider rejected the API key. Check or replace the key for this provider in Settings > Models.",
    } as unknown as Run;
    renderAt(createMockClient({ seed: 7 }), <ModelProviderNotice runs={[failed]} />);
    expect(await screen.findByText(/rejected the API key/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open model settings" }));
    expect(await screen.findByText("models settings page")).toBeDefined();
    cleanup();
    const succeeded = { ...failed, id: "run-2", status: "completed", error: undefined, startedAt: "2026-10-13T10:05:00.000Z" } as Run;
    const client = createMockClient({ seed: 7 });
    renderAt(client, <ModelProviderNotice runs={[failed, succeeded]} />);
    await waitFor(async () => expect((await client.modelProviders.list()).usable).toBe(true));
    expect(screen.queryByText(/rejected the API key/)).toBeNull();
  });

  it("offers model settings on a run failure that names Settings > Models, not on others", () => {
    const client = createMockClient({ seed: 7 });
    renderAt(client, <ModelSetupAction error="No model provider is configured. Add one in Settings > Models." />);
    expect(screen.getByRole("button", { name: "Open model settings" })).toBeDefined();
    cleanup();
    renderAt(client, <ModelSetupAction error="The tool crashed." />);
    expect(screen.queryByRole("button", { name: "Open model settings" })).toBeNull();
  });
});
