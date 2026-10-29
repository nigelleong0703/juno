import { createMockClient } from "@agent-desktop/test-fixtures";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApps, stubResizeObserver } from "./appsTestKit";

stubResizeObserver();
afterEach(cleanup);

const failure = (code: string, message: string) => Object.assign(new Error(message), { status: 400, code });

describe("App detail: adding", () => {
  it("Connect starts the install and opens the sign-in page it returns", async () => {
    const client = createMockClient({ seed: 7 });
    const install = vi.spyOn(client.apps, "install");
    const openExternal = renderApps(client, "/apps/notion");
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://accounts.example.test/auth?app=notion"));
    expect(install).toHaveBeenCalledWith("notion", {});
  });

  it("an app that declares values opens a form with the secret as a secure field, then sends them", async () => {
    const client = createMockClient({ seed: 7 });
    const install = vi.spyOn(client.apps, "install");
    renderApps(client, "/apps/hevy");
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog");
    const key = within(dialog).getByLabelText("Hevy API key");
    expect(key.getAttribute("type")).toBe("password");
    // Required: nothing to send until it is filled.
    expect(within(dialog).getByRole("button", { name: "Connect" })).toHaveProperty("disabled", true);
    expect(install).not.toHaveBeenCalled();
    fireEvent.change(key, { target: { value: "secret-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("hevy", { userConfig: { api_key: "secret-key" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a key the server's probe call rejects shows its message and stays on the form, with what was typed", async () => {
    const client = createMockClient({ seed: 7 });
    const install = vi.spyOn(client.apps, "install");
    renderApps(client, "/apps/hevy");
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Hevy API key"), { target: { value: "bad-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/Could not connect Hevy: the server rejected the key/u);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByLabelText("Hevy API key")).toHaveProperty("value", "bad-key");
    // Fixing the value and sending again connects.
    fireEvent.change(within(dialog).getByLabelText("Hevy API key"), { target: { value: "good-key" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(install).toHaveBeenLastCalledWith("hevy", { userConfig: { api_key: "good-key" } }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("CONNECTOR_CONFIG_REQUIRED from the server opens the form too", async () => {
    const client = createMockClient({ seed: 7 });
    vi.spyOn(client.apps, "install").mockRejectedValueOnce(failure("CONNECTOR_CONFIG_REQUIRED", "A value is required"));
    renderApps(client, "/apps/notion");
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connect Notion" })).toBeTruthy();
  });

  it("a web app that needs no sign-in is added with no values, then agents are switched on and it can be removed", async () => {
    const client = createMockClient({ seed: 7 });
    const install = vi.spyOn(client.apps, "install");
    const remove = vi.spyOn(client.apps, "removeInstallation");
    renderApps(client, "/apps/youtube-videos");
    expect(await screen.findByText("Reads public pages. No sign-in.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "What agents can do" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("youtube-videos", {}));
    expect(await screen.findByRole("button", { name: /Juno is on/u })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove app" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("youtube-videos", expect.any(String)));
  });

  it("a web app that still needs a sandbox sign-in cannot be added and says so", async () => {
    const client = createMockClient({ seed: 7 });
    const install = vi.spyOn(client.apps, "install");
    renderApps(client, "/apps/xiaohongshu");
    const button = await screen.findByRole("button", { name: "Coming soon" });
    expect(button).toHaveProperty("disabled", true);
    expect(install).not.toHaveBeenCalled();
  });

  it("a Try asking prompt starts a new chat", async () => {
    renderApps(createMockClient({ seed: 7 }), "/apps/gmail");
    fireEvent.click(await screen.findByRole("button", { name: "Summarise my unread email" }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/new"));
  });
});

describe("App detail: agents and actions", () => {
  it("a work app's avatar row turns an agent off and on through the agent's own route", async () => {
    const client = createMockClient({ seed: 7 });
    const setAgentApp = vi.spyOn(client.apps, "setAgentApp");
    renderApps(client, "/apps/gmail");
    fireEvent.click(await screen.findByRole("button", { name: /Juno is on/u }));
    await waitFor(() => expect(setAgentApp).toHaveBeenCalledWith("agent-juno", "gmail", { enabled: false }));
    fireEvent.click(await screen.findByRole("button", { name: /Juno is off/u }));
    await waitFor(() => expect(setAgentApp).toHaveBeenLastCalledWith("agent-juno", "gmail", { enabled: true }));
  });

  it("a chat app's avatar row switches an agent in that workspace", async () => {
    const client = createMockClient({ seed: 7 });
    const setWorkspaceAgent = vi.spyOn(client.apps, "setWorkspaceAgent");
    const setAgentApp = vi.spyOn(client.apps, "setAgentApp");
    renderApps(client, "/apps/slack");
    expect(await screen.findByRole("region", { name: "Agents in Acme Lab" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Patch is off/u }));
    await waitFor(() => expect(setWorkspaceAgent).toHaveBeenCalledWith("slack", "inst-slack-1", "agent-patch", { enabled: true }));
    expect(setAgentApp).not.toHaveBeenCalled();
  });

  it("lists what agents can do as Read or Asks first, and sets the Actions policy per agent", async () => {
    const client = createMockClient({ seed: 7 });
    const setAgentApp = vi.spyOn(client.apps, "setAgentApp");
    renderApps(client, "/apps/gmail");
    const canDo = await screen.findByRole("region", { name: "What agents can do" });
    expect(within(canDo).getByText("Search your email").parentElement?.textContent).toMatch(/Read/u);
    expect(within(canDo).getByText("Send an email").parentElement?.textContent).toMatch(/Asks first/u);
    const actions = await screen.findByRole("region", { name: "Actions" });
    const juno = within(actions).getByRole("radiogroup", { name: "Actions for Juno" });
    fireEvent.click(within(juno).getByRole("radio", { name: "Allow" }));
    await waitFor(() => expect(setAgentApp).toHaveBeenCalledWith("agent-juno", "gmail", { enabled: true, actionsPolicy: "allow" }));
  });
});

describe("App detail: tools that changed", () => {
  it("flags a new tool, and Mark reviewed clears the flag through the review call", async () => {
    const client = createMockClient({ seed: 7 });
    const review = vi.spyOn(client.apps, "reviewTools");
    renderApps(client, "/apps/gmail");
    const canDo = await screen.findByRole("region", { name: "What agents can do" });
    expect(within(canDo).getByText("Create a draft").parentElement?.textContent).toMatch(/New/u);
    expect(within(canDo).getByText("Send an email").parentElement?.textContent).not.toMatch(/New/u);
    fireEvent.click(within(canDo).getByRole("button", { name: "Mark reviewed" }));
    await waitFor(() => expect(review).toHaveBeenCalledWith("gmail", {}));
    await waitFor(() => expect(within(canDo).queryByRole("button", { name: "Mark reviewed" })).toBeNull());
    expect(within(canDo).queryByText("New")).toBeNull();
  });
});

describe("App detail: accounts", () => {
  it("removes one account after a confirm", async () => {
    const client = createMockClient({ seed: 7 });
    const remove = vi.spyOn(client.apps, "removeInstallation");
    renderApps(client, "/apps/gmail");
    fireEvent.click(await screen.findByRole("button", { name: /Remove robin@example.com/u }));
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("gmail", expect.any(String)));
  });

  it("an expired account says so and Sign in again re-signs that account", async () => {
    const client = createMockClient({ seed: 7 });
    const install = vi.spyOn(client.apps, "install");
    const openExternal = renderApps(client, "/apps/google-calendar");
    const row = (await screen.findByRole("region", { name: "Accounts" })).querySelector("li") as HTMLElement;
    expect(row.textContent).toMatch(/Sign-in expired/u);
    fireEvent.click(within(row).getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("google-calendar", { connectionId: expect.any(String) }));
    await waitFor(() => expect(openExternal).toHaveBeenCalled());
  });
});
