import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { useLiveSync } from "../../../data/liveSync";
import { webPlatform } from "../../../platform";
import { MyMacSection } from "../MyMacSection";

afterEach(cleanup);

function Page() {
  useLiveSync();
  return <MyMacSection />;
}

async function renderPairedMac() {
  const client = createMockClient({ seed: 402 });
  await client.computers.pairMyMac({ name: "Studio Mac" });
  render(
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ClientProvider client={client} events={client} platform={webPlatform} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
          <Page />
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  return client;
}

describe("My Mac on the web: Stop, never Resume", () => {
  it("Stop calls the Mac's stop route and the row reads 'Stopped · resume on your Mac' with nothing to resume from here", async () => {
    const client = await renderPairedMac();
    const stopMyMac = vi.spyOn(client.computers, "stopMyMac");
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(stopMyMac).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Stopped · resume on your Mac")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /Resume/u })).toBeNull();
  });

  it("a Stop pressed on the Mac shows up live, and resuming on the Mac clears it", async () => {
    const client = await renderPairedMac();
    await screen.findByRole("button", { name: "Stop" });
    // The Mac's own Stop reaches the server, which tells every open client.
    await act(async () => {
      await client.computers.stopMyMac();
    });
    expect(await screen.findByText("Stopped · resume on your Mac")).toBeTruthy();
    act(() => client.resumeMyMac());
    await waitFor(() => expect(screen.queryByText("Stopped · resume on your Mac")).toBeNull());
    expect(screen.getByRole("button", { name: "Stop" })).toHaveProperty("disabled", false);
  });
});
