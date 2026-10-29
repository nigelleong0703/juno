import type { Agent, ApiClient } from "@agent-desktop/client";
import { ThemeProvider, TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { applyEvent } from "../../../data/liveSync";
import { qk } from "../../../data/keys";
import { useAgent } from "../../../data/queries";
import type { RoleSuggestionItem as RoleSuggestionItemType } from "../../../lib/items";
import { RoleSuggestionItem } from "../RoleSuggestionItem";

beforeAll(() => {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
});

afterEach(cleanup);

const ISO = "2026-10-05T09:30:00.000Z";
const DISMISSED_AT = "2026-10-05T10:00:00.000Z";

function makeAgent(overrides: Partial<Agent> & { withSuggestion?: boolean } = {}): Agent {
  const { withSuggestion = true, ...rest } = overrides;
  return {
    id: "agent-1",
    name: "Sage",
    handle: "sage",
    avatar: { shape: "circle", color: 1, eyes: "dot" },
    title: "Agent",
    description: "",
    status: "idle",
    section: "Work",
    pinned: false,
    lastActivity: "",
    unreadCount: 0,
    model: {
      planner: { provider: "openai", model: "gpt" },
      computer: { provider: "openai", model: "gpt" },
      fast: { provider: "openai", model: "gpt" },
    },
    channels: [],
    computerId: "computer-shared",
    skillIds: [],
    pluginIds: [],
    createdAt: ISO,
    updatedAt: ISO,
    roleSuggestion: withSuggestion
      ? { title: "Research analyst", description: "Tracks sources and summarises findings.", createdAt: ISO }
      : undefined,
    ...rest,
  } as unknown as Agent;
}

function makeItem(overrides: Partial<RoleSuggestionItemType> = {}): RoleSuggestionItemType {
  return {
    id: "rsg-agent-1-1",
    conversationId: "conv-1",
    type: "role_suggestion",
    agentId: "agent-1",
    title: "Research analyst",
    description: "Tracks sources and summarises findings.",
    suggestionAt: ISO,
    at: ISO,
    ...overrides,
  } as RoleSuggestionItemType;
}

/** Mirrors the transcript: the card reads its agent from the query cache, as in the app. */
function Harness({ item }: { item: RoleSuggestionItemType }) {
  useAgent(item.agentId);
  return <RoleSuggestionItem item={item} />;
}

/**
 * A fake server: `publish` pushes a full agent snapshot through the real `agent.updated` reducer, the
 * same path SSE takes. Accept clears the suggestion and sets the title; dismiss stamps the dismissal.
 */
function setup(initial: Agent, item: RoleSuggestionItemType = makeItem()) {
  let server = initial;
  const client = {
    agents: {
      get: vi.fn(async () => server),
      acceptRoleSuggestion: vi.fn(async () => {
        const { roleSuggestion } = server;
        server = { ...server, title: roleSuggestion?.title ?? server.title, roleSuggestion: undefined } as Agent;
        return server;
      }),
      dismissRoleSuggestion: vi.fn(async () => {
        server = { ...server, roleSuggestion: undefined, roleSuggestionDismissedAt: DISMISSED_AT } as Agent;
        return server;
      }),
      update: vi.fn(async (_id: string, patch: { title?: string }) => (server = { ...server, ...patch })),
    },
  } as unknown as ApiClient & {
    agents: Record<"get" | "acceptRoleSuggestion" | "dismissRoleSuggestion" | "update", ReturnType<typeof vi.fn>>;
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(qk.agent(initial.id), initial);
  const view = render(
    <ThemeProvider defaultTheme="light">
      <TooltipProvider>
        <ClientProvider client={client} queryClient={queryClient}>
          <Harness item={item} />
        </ClientProvider>
      </TooltipProvider>
    </ThemeProvider>,
  );
  const publish = (agent: Agent) => {
    server = agent;
    applyEvent(queryClient, { type: "agent.updated", agent } as never);
  };
  return { client, queryClient, publish, unmount: view.unmount };
}

describe("RoleSuggestionItem", () => {
  it("shows a pending suggestion as a card with its title, description and an editable name", async () => {
    setup(makeAgent());
    expect(await screen.findByText("Sage looks like your…")).toBeTruthy();
    expect(screen.getByText("Research analyst", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("Tracks sources and summarises findings.")).toBeTruthy();
    expect((screen.getByLabelText("Role name") as HTMLInputElement).value).toBe("Research analyst");
    expect(screen.getByRole("button", { name: "Use this role" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });

  it("Use this role accepts without patching when the name is unchanged", async () => {
    const { client } = setup(makeAgent());
    fireEvent.click(await screen.findByRole("button", { name: "Use this role" }));
    await waitFor(() => expect(client.agents.acceptRoleSuggestion).toHaveBeenCalledWith("agent-1"));
    expect(await screen.findByText("Role set: Research analyst")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this role" })).toBeNull();
    expect(client.agents.update).not.toHaveBeenCalled();
    expect(client.agents.dismissRoleSuggestion).not.toHaveBeenCalled();
  });

  it("Use this role accepts, then renames when the name was edited", async () => {
    const { client } = setup(makeAgent());
    fireEvent.change(await screen.findByLabelText("Role name"), { target: { value: "  Market researcher " } });
    fireEvent.click(screen.getByRole("button", { name: "Use this role" }));
    await waitFor(() => expect(client.agents.update).toHaveBeenCalledWith("agent-1", { title: "Market researcher" }));
    expect(client.agents.acceptRoleSuggestion.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      client.agents.update.mock.invocationCallOrder[0] ?? 0,
    );
    expect(await screen.findByText("Role set: Market researcher")).toBeTruthy();
  });

  it("Not now dismisses on the server and the card resolves to a muted Not now line", async () => {
    const { client } = setup(makeAgent());
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() => expect(client.agents.dismissRoleSuggestion).toHaveBeenCalledWith("agent-1"));
    expect(client.agents.acceptRoleSuggestion).not.toHaveBeenCalled();
    expect(await screen.findByText("Not now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
  });

  it("resolves live when the agent is updated elsewhere (accepted on another client)", async () => {
    const { publish } = setup(makeAgent());
    await screen.findByRole("button", { name: "Use this role" });
    publish(makeAgent({ title: "Research analyst", roleSuggestion: undefined }));
    expect(await screen.findByText("Role set: Research analyst")).toBeTruthy();
  });

  it("a newer suggestion on the agent leaves this older card resolved", async () => {
    setup(makeAgent({ roleSuggestion: { title: "Coach", description: "Plans workouts.", createdAt: "2026-10-06T09:30:00.000Z" } as never }));
    expect(await screen.findByText("Not now")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use this role" })).toBeNull();
  });

  it("a dismissal at or after the suggestion resolves to Not now even when the title was later set", async () => {
    setup(makeAgent({ withSuggestion: false, title: "Coach", roleSuggestionDismissedAt: DISMISSED_AT } as never));
    expect(await screen.findByText("Not now")).toBeTruthy();
  });

  it("an accepted suggestion with a real role shows Role set with the agent's current title", async () => {
    setup(makeAgent({ withSuggestion: false, title: "Coach" }));
    expect(await screen.findByText("Role set: Coach")).toBeTruthy();
  });

  it("no real role and no pending suggestion resolves to Not now", async () => {
    setup(makeAgent({ withSuggestion: false, title: "Agent" }));
    expect(await screen.findByText("Not now")).toBeTruthy();
  });
});
