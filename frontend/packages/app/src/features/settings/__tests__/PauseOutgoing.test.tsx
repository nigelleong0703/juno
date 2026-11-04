import { createMockClient, type MockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { PauseOutgoing } from "../PauseOutgoing";

afterEach(cleanup);

const failing = (platform: string) => ({ platform, channelId: `${platform}-1`, consecutiveFailures: 3, lastError: "boom", since: "2026-11-01T10:00:00.000Z" });

function renderRow(client: MockClient) {
  render(
    <ClientProvider client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <PauseOutgoing />
        </TooltipProvider>
      </ThemeProvider>
    </ClientProvider>,
  );
}

describe("Pause outgoing messages", () => {
  it("turns the owner's pause on and off through the switch", async () => {
    const client = createMockClient({ seed: 7 });
    renderRow(client);
    const toggle = await screen.findByRole("switch", { name: "Pause outgoing messages" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(client.delivery.frozen.owner).toBe(true));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Pause outgoing messages" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("switch", { name: "Pause outgoing messages" }));
    await waitFor(() => expect(client.delivery.frozen.owner).toBe(false));
  });

  it("shows the service's pause as on and locked", async () => {
    const client = createMockClient({ seed: 7 });
    client.delivery.frozen.operator = true;
    renderRow(client);
    const toggle = await screen.findByRole("switch", { name: "Pause outgoing messages" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Paused by the service.")).toBeTruthy();
  });

  it("names each app that is not delivering, three at most", async () => {
    const client = createMockClient({ seed: 7 });
    client.delivery.failing.push(failing("telegram"), failing("telegram"), failing("slack"), failing("discord"), failing("ios"), failing("feishu"));
    renderRow(client);
    expect(await screen.findByText("Telegram isn't delivering right now")).toBeTruthy();
    expect(screen.getByText("Slack isn't delivering right now")).toBeTruthy();
    expect(screen.getByText("Discord isn't delivering right now")).toBeTruthy();
    expect(screen.getByText("and 2 more")).toBeTruthy();
    expect(screen.queryByText("Feishu / Lark isn't delivering right now")).toBeNull();
  });
});
