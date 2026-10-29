import type { ApiClient, Request, ResolveRequestInput } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { TooltipProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { LiveRequestCard } from "../LiveRequestCard";
import { RequestCard } from "../RequestCard";

afterEach(cleanup);

async function emailRequest(client: ApiClient): Promise<Request> {
  return client.requests.get("req-juno-email");
}

function renderCard(client: ApiClient, ui: (request: Request) => React.ReactElement, request: Request) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <TooltipProvider>
      <ClientProvider client={client} queryClient={queryClient}>
        {ui(request)}
      </ClientProvider>
    </TooltipProvider>,
  );
}

describe("decision card", () => {
  it("shows the platform, the sentence, its kind and the consequences, with what only the agent says greyed", async () => {
    const client = createMockClient({ seed: 3 });
    renderCard(client, (request) => <RequestCard request={request} onResolve={() => {}} />, await emailRequest(client));
    expect(screen.getByText("Gmail")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Email the sandbox comparison to team@example.com" })).toBeDefined();
    expect(screen.getByText("Speaking for you")).toBeDefined();
    expect(screen.getByText("To team@example.com")).toBeDefined();
    expect(screen.getByText("As robin@example.com")).toBeDefined();
    // "Can't be undone" is declared by the agent, not verified.
    expect(screen.getByText("Can’t be undone").parentElement?.textContent).toMatch(/agent says/u);
    expect(screen.getByText(/If you say no: I will keep the draft/u)).toBeDefined();
  });

  it("sends the right resolve body for Allow once, Change it and Deny", async () => {
    const client = createMockClient({ seed: 3 });
    const bodies: ResolveRequestInput[] = [];
    const onResolve = vi.fn((decision: ResolveRequestInput) => bodies.push(decision));
    renderCard(client, (request) => <RequestCard request={request} onResolve={onResolve} />, await emailRequest(client));

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Change it…" }));
    fireEvent.change(await screen.findByLabelText("Change it", { selector: "textarea" }), { target: { value: "Use the shorter version" } });
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    expect(bodies).toEqual([
      { action: "approve", scope: "once" },
      { action: "deny" },
      { action: "deny", reason: "revise", note: "Use the shorter version" },
    ]);
  });

  it("offers Allow this kind only when the server says the kind can be delegated, and creates the rules it resolves with", async () => {
    const base = createMockClient({ seed: 3 });
    const request = await emailRequest(base);
    // Not delegable: no such button.
    const closed: Request = request.payload.kind === "approval" ? { ...request, payload: { ...request.payload, delegationOffer: { delegable: false, reason: "Not yet", suggested: [] } } } : request;
    const view = renderCard(base, (entry) => <RequestCard request={entry} onResolve={() => {}} />, closed);
    expect(screen.queryByRole("button", { name: "Allow this kind…" })).toBeNull();
    view.unmount();

    // Delegable: edit the suggested limit, confirm, and the rule exists afterwards with that limit.
    renderCard(base, (entry) => <LiveRequestCard request={entry} />, request);
    fireEvent.click(screen.getByRole("button", { name: "Allow this kind…" }));
    fireEvent.change(await screen.findByLabelText("Most per day"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Allow once and set rule" }));
    await waitFor(async () => {
      const rules = (await base.delegations.list({ agentId: "agent-juno" })).items;
      expect(rules.some((rule) => rule.delegation?.platformKey === "app:gmail" && rule.delegation.limits.maxPerDay === 5)).toBe(true);
    });
    expect((await base.requests.get("req-juno-email")).outcome).toBe("allowed_once");
  });

  it("a sharing offer names the chats it covers (the server's title, else the conversation's own, else 'a chat') and resolves as a delegation", async () => {
    const base = createMockClient({ seed: 3 });
    const request = await emailRequest(base);
    const recipients = ["conv-offsite", "conv-gone"];
    const sharing: Request =
      request.payload.kind === "approval" && request.payload.brief
        ? {
            ...request,
            payload: {
              ...request.payload,
              brief: { ...request.payload.brief, categories: ["sharing"], primary: "sharing" },
              delegationOffer: { delegable: true, suggested: [{ category: "sharing", platform: { kind: "chat", conversationId: "conv-launch", title: "work" }, limits: { recipients } }] },
            },
          }
        : request;
    renderCard(base, (entry) => <LiveRequestCard request={entry} />, sharing);
    expect(screen.getByText("Share between chats")).toBeDefined();
    // "conv-offsite" is looked up once the chat list is in; "conv-gone" is not a chat the owner has.
    fireEvent.click(await screen.findByRole("button", { name: "Always allow files from #work in #Offsite crew, a chat…" }));
    expect(await screen.findByRole("heading", { name: "Always allow files from #work in #Offsite crew, a chat" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Allow once and set rule" }));
    await waitFor(async () => {
      const rules = (await base.delegations.list({ agentId: "agent-juno" })).items;
      const rule = rules.find((entry) => entry.delegation?.category === "sharing");
      expect(rule?.delegation?.platformKey).toBe("chat:conv-launch");
      expect(rule?.delegation?.limits.recipients).toEqual(recipients);
      expect(rule?.expiresAt).toBeDefined();
    });
    expect((await base.requests.get("req-juno-email")).outcome).toBe("allowed_once");
  });

  it("an app on the owner's Mac: use asks Allow once, Always allow (scope app) or Don't allow; bringing it to the front is approve or deny only", async () => {
    const client = createMockClient({ seed: 3 });
    const request = await emailRequest(client);
    const withApp = (purpose: "use" | "foreground"): Request =>
      request.payload.kind === "approval" ? { ...request, payload: { ...request.payload, macApp: { app: "com.apple.notes", name: "Notes", purpose } } } : request;
    const bodies: ResolveRequestInput[] = [];
    const onResolve = (decision: ResolveRequestInput) => bodies.push(decision);

    const use = renderCard(client, (entry) => <RequestCard request={entry} onResolve={onResolve} />, withApp("use"));
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Don't allow" }));
    expect(screen.queryByRole("button", { name: "Allow this kind…" })).toBeNull();
    expect(bodies).toEqual([{ action: "approve" }, { action: "approve", scope: "app" }, { action: "deny" }]);
    use.unmount();

    renderCard(client, (entry) => <RequestCard request={entry} onResolve={onResolve} />, withApp("foreground"));
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(bodies.at(-1)).toEqual({ action: "approve" });
  });

  it("a decided one is a slim row with the outcome in words", async () => {
    const client = createMockClient({ seed: 3 });
    renderCard(client, (request) => <RequestCard request={request} />, await client.requests.get("req-decided-revised"));
    expect(screen.getByRole("button", { name: /Sent back to change/u }).textContent).toMatch(/Post the launch photo to Instagram/u);
  });
});
