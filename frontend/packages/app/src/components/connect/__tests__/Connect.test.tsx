import type { ApiClient, AppProblem, Request, Routine } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationList } from "../../../features/automations/AutomationList";
import { renderApps, stubResizeObserver } from "../../../features/apps/__tests__/appsTestKit";
import { connectAction } from "../../../lib/apps";
import { RequestCard } from "../../request/RequestCard";

stubResizeObserver();
afterEach(cleanup);

const ISO = "2026-10-06T00:00:00.000Z";

const connectRequest = (payload: Partial<Extract<Request["payload"], { kind: "connect" }>> = {}, status: Request["status"] = "pending"): Request => ({
  id: "req-connect",
  kind: "connect",
  status,
  title: "Connect your apps",
  summary: "",
  agentId: "agent-juno",
  createdAt: ISO,
  payload: { kind: "connect", appIds: ["notion"], label: "Notion", ...payload },
});

describe("connect card", () => {
  it("offers the action each app needs: Add, Turn on for the agent, Reconnect", async () => {
    const client = createMockClient({ seed: 7 });
    // Gmail is added and on for every agent; take Juno off it so the card's reason is true.
    await client.apps.setAgentApp("agent-juno", "gmail", { enabled: false });
    const setAgentApp = vi.spyOn(client.apps, "setAgentApp");
    const install = vi.spyOn(client.apps, "install");
    const resolved: unknown[] = [];
    const openExternal = renderApps(
      client,
      "/c/chat",
      <RequestCard
        request={connectRequest({
          appIds: ["notion", "gmail", "google-calendar"],
          problems: { notion: "not_added", gmail: "not_enabled", "google-calendar": "expired" },
          label: "Notion, Gmail or Google Calendar",
        })}
        onResolve={(decision) => resolved.push(decision)}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Turn on for Juno" }));
    await waitFor(() => expect(setAgentApp).toHaveBeenCalledWith("agent-juno", "gmail", { enabled: true }));

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("google-calendar", { connectionId: expect.any(String) }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("https://accounts.example.test/auth?app=google-calendar"));

    fireEvent.click(screen.getByRole("button", { name: "Add Notion" }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/apps/notion"));
    expect(resolved).toEqual([]);
  });

  it("a sign-in that never worked or lacks a permission is reconnected the same way, and the rows follow the card's appIds order", () => {
    expect(connectAction("needs_reconnect")).toBe("reconnect");
    expect(connectAction("expired")).toBe("reconnect");
    expect(connectAction("scope_missing")).toBe("reconnect");
    expect(connectAction("not_enabled")).toBe("turn-on");
    expect(connectAction("not_added")).toBe("add");
    // A problem the client does not know yet falls back to the safe action, not a crash.
    expect(connectAction("something_new" as AppProblem)).toBe("add");
  });

  it("lists the apps in the order the card names them", async () => {
    renderApps(
      createMockClient({ seed: 7 }),
      "/c/chat",
      <RequestCard request={connectRequest({ appIds: ["hevy", "notion"], problems: { hevy: "not_added", notion: "not_added" }, label: "Hevy or Notion" })} onResolve={() => undefined} />,
    );
    // The catalog lists Notion before Hevy; the card's own order wins.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Add / }).map((button) => button.textContent)).toEqual(["Add Hevy", "Add Notion"]));
  });

  it("a routine's card has a tile per app and Not now denies", async () => {
    const resolved: unknown[] = [];
    renderApps(
      createMockClient({ seed: 7 }),
      "/c/chat",
      <RequestCard request={connectRequest({ appIds: ["notion", "hevy"], problems: { notion: "not_added", hevy: "not_added" }, routineId: "routine-1", label: "Notion or Hevy" })} onResolve={(decision) => resolved.push(decision)} />,
    );
    expect(await screen.findByRole("button", { name: "Add Notion" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Hevy" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(resolved).toEqual([{ action: "deny" }]);
  });

  it("an app the agent can use by now shows Ready instead of a button, and a decided card has none", async () => {
    renderApps(createMockClient({ seed: 7 }), "/c/chat", <RequestCard request={connectRequest({ appIds: ["gmail"], problems: { gmail: "not_enabled" }, label: "Gmail" })} onResolve={() => undefined} />);
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn on|Add|Reconnect/u })).toBeNull();
    cleanup();

    renderApps(createMockClient({ seed: 7 }), "/c/chat", <RequestCard request={{ ...connectRequest({ appIds: ["notion"], problems: { notion: "not_added" } }, "approved"), resolvedAt: ISO }} />);
    expect(screen.queryByRole("button", { name: "Add Notion" })).toBeNull();
  });
});

describe("routine waiting on an app", () => {
  it("shows what it needs with the action per app and a switch that does not claim it runs", async () => {
    const base = createMockClient({ seed: 5 });
    const [first] = (await base.routines.list()).items;
    const routine: Routine = {
      ...(first as Routine),
      enabled: true,
      status: "needs_setup",
      missing: [
        { capability: "calendar", options: ["google-calendar", "notion"], label: "Google Calendar or Notion" },
        { capability: "search", options: ["web_search"], label: "Web search" },
      ],
    };
    renderApps(base, "/automations", <AutomationList routines={[routine]} />);
    expect(screen.getByText("Needs setup: connect Google Calendar or Notion")).toBeTruthy();
    expect(screen.getByText("Needs setup: connect Web search")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Notion" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Add|Reconnect|Turn on/u })).toHaveLength(2);
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle).toHaveProperty("disabled", true);
  });
});

describe("Mac option of a connect card", () => {
  const macRequest = (): Request => connectRequest({ appIds: ["mac"], label: "Your Mac" });
  const clientWithMac = (status: { paired: boolean; online: boolean }, macAccess: boolean) => {
    const base = createMockClient({ seed: 5 });
    return {
      ...base,
      computers: { ...base.computers, myMac: async () => status },
      agents: { ...base.agents, get: async (id: string) => ({ ...(await base.agents.get(id)), macAccess }) },
    } as ApiClient as typeof base;
  };

  it("pairing first (web cannot pair), then allowing the agent, then offline with nothing to tap", async () => {
    renderApps(clientWithMac({ paired: false, online: false }, false), "/c/chat", <RequestCard request={macRequest()} onResolve={() => undefined} />);
    expect(await screen.findByText("Open Juno on your Mac to pair.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pair|Allow/u })).toBeNull();
    cleanup();

    renderApps(clientWithMac({ paired: true, online: true }, false), "/c/chat", <RequestCard request={macRequest()} onResolve={() => undefined} />);
    expect(await screen.findByRole("button", { name: /Allow .* to use your Mac/u })).toBeTruthy();
    expect(screen.getByText(/macOS will ask once/u)).toBeTruthy();
    cleanup();

    renderApps(clientWithMac({ paired: true, online: false }, true), "/c/chat", <RequestCard request={macRequest()} onResolve={() => undefined} />);
    expect(await screen.findByText("Your Mac is offline. Open Juno on it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pair|Allow/u })).toBeNull();
  });
});
