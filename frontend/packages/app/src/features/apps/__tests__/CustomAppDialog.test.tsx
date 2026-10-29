import { createMockClient } from "@agent-desktop/test-fixtures";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomAppDialog } from "../CustomAppDialog";
import { renderApps, stubResizeObserver } from "./appsTestKit";

stubResizeObserver();
afterEach(cleanup);

const fill = (name: string, url: string) => {
  fireEvent.change(screen.getByPlaceholderText("e.g. Linear"), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText("https://mcp.example.com/mcp"), { target: { value: url } });
};

describe("Add a custom app", () => {
  it("checks the server first, lets the person flip a mark, and installs with exactly that confirmation", async () => {
    const client = createMockClient({ seed: 7 });
    const install = vi.spyOn(client.apps, "install");
    renderApps(client, "/x", <CustomAppDialog onClose={() => {}} />);
    fill("Docs", "https://mcp.example.com/mcp");
    fireEvent.click(screen.getByRole("button", { name: "Check server" }));

    // The confirm step: how it signs in, and each tool as the server's annotations suggest.
    expect(await screen.findByText("Opens without signing in.")).toBeTruthy();
    const sync = screen.getByRole("button", { name: /Sync/u });
    expect(sync.textContent).toMatch(/Changes/u);
    fireEvent.click(sync);
    expect(sync.textContent).toMatch(/Read/u);
    expect(install).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
    expect(install.mock.calls[0]?.[1]).toMatchObject({
      name: "Docs",
      url: "https://mcp.example.com/mcp",
      confirm: { auth: "none", tools: { search_docs: "read", get_page: "read", create_page: "change", sync: "read" } },
    });
  });

  it("keeps the form open with the server's reason when the login cannot be used", async () => {
    renderApps(createMockClient({ seed: 7 }), "/x", <CustomAppDialog onClose={() => {}} />);
    fill("Keyed", "https://mcp.example.com/keyed");
    fireEvent.click(screen.getByRole("button", { name: "Check server" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/API key/u);
    expect(screen.getByRole("button", { name: "Check server" })).toBeTruthy();
  });

  it("checks again and says so when the server now asks for something different", async () => {
    const client = createMockClient({ seed: 7 });
    renderApps(client, "/x", <CustomAppDialog onClose={() => {}} />);
    fill("Docs", "https://mcp.example.com/mcp");
    fireEvent.click(screen.getByRole("button", { name: "Check server" }));
    await screen.findByText("Opens without signing in.");

    // The server's login changed since it was checked: the install is refused with 409 and the person sees the new check.
    const refuse = Object.assign(new Error("changed"), { code: "CUSTOM_PROBE_CHANGED" });
    vi.spyOn(client.apps, "install").mockRejectedValueOnce(refuse);
    vi.spyOn(client.apps, "probeCustom").mockResolvedValueOnce({ url: "https://mcp.example.com/mcp", auth: "oauth", usable: true, oauth: { issuer: "https://login.example.com", scopes: [], client: "dcr" } });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    expect(await screen.findByText("Signs in with https://login.example.com.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/asks for something different/u);
  });
});
