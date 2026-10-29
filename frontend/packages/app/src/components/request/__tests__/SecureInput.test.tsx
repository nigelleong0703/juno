import type { ApiClient, Request } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { ThemeProvider } from "@agent-desktop/ui";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthContext } from "../../../auth/AuthContext";
import { ClientProvider } from "../../../data/ClientProvider";
import { qk } from "../../../data/keys";
import vector from "../../../lib/__tests__/secure-input-vector.json";
import { openSealed } from "../../../lib/__tests__/openSealed";
import { LiveRequestCard } from "../LiveRequestCard";

afterEach(cleanup);

const SECRET = "4111111111111111";

/** Everything react-query holds (queries and mutations), as text, to prove a secret is not in it. */
function cacheDump(queryClient: QueryClient): string {
  const queries = queryClient.getQueryCache().getAll().map((q) => JSON.stringify([q.queryKey, q.state.data]));
  const mutations = queryClient.getMutationCache().getAll().map((m) => JSON.stringify([m.state.variables, m.state.data]));
  return [...queries, ...mutations].join("\n");
}

async function renderSecure(client: ApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const request = await client.requests.get("req-juno-secure");
  render(
    <ThemeProvider defaultTheme="light">
      <AuthContext.Provider value={{ mode: "account", user: { id: "member-robin", name: "Robin", email: "n@example.com", initials: "N" }, signOut: () => {} }}>
        <ClientProvider client={client} queryClient={queryClient}>
          <MemoryRouter>
            <LiveRequestCard request={request} />
          </MemoryRouter>
        </ClientProvider>
      </AuthContext.Provider>
    </ThemeProvider>,
  );
  return queryClient;
}

describe("secure input", () => {
  it("sends the typed values once, then neither the page nor any cache holds them", async () => {
    const base = createMockClient({ seed: 3 });
    const submit = vi.fn(base.requests.submitSecureInput);
    const client: ApiClient = { ...base, requests: { ...base.requests, submitSecureInput: submit } };
    const queryClient = await renderSecure(client);

    expect(await screen.findByText(/Secure input · /u)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Enter securely" }));
    fireEvent.change(await screen.findByLabelText("Card number"), { target: { value: SECRET } });
    fireEvent.change(screen.getByLabelText("Expiry"), { target: { value: "08/28" } });
    fireEvent.change(screen.getByLabelText("CVC"), { target: { value: "123" } });
    expect((screen.getByLabelText("CVC") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getAllByRole("button", { name: "Enter securely" }).at(-1) as HTMLElement);

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const sent = submit.mock.calls[0]?.[1].fields ?? {};
    expect(Object.keys(sent)).toEqual(["f1", "f2", "f3"]);
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(await openSealed(sent.f1!, vector.sandboxPrivateKey, "req-juno-secure", "f1", "")).toBe(SECRET);
    expect(await openSealed(sent.f3!, vector.sandboxPrivateKey, "req-juno-secure", "f3", "")).toBe("123");
    await waitFor(() => expect(queryClient.getQueryData<Request>(qk.request("req-juno-secure"))?.status).toBe("approved"));
    await waitFor(() => expect(screen.queryByLabelText("Card number")).toBeNull());
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(cacheDump(queryClient)).not.toContain(SECRET);
  });

  it("clears the fields when the screen is under the user's control and says to hand it back", async () => {
    const base = createMockClient({ seed: 3 });
    const refused = Object.assign(new Error("hand the screen back"), { status: 409, code: "USER_CONTROL" });
    const client: ApiClient = { ...base, requests: { ...base.requests, submitSecureInput: async () => { throw refused; } } };
    const queryClient = await renderSecure(client);
    fireEvent.click(await screen.findByRole("button", { name: "Enter securely" }));
    fireEvent.change(await screen.findByLabelText("Card number"), { target: { value: SECRET } });
    fireEvent.change(screen.getByLabelText("Expiry"), { target: { value: "08/28" } });
    fireEvent.change(screen.getByLabelText("CVC"), { target: { value: "123" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Enter securely" }).at(-1) as HTMLElement);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Hand it back/u);
    expect((screen.getByLabelText("Card number") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(cacheDump(queryClient)).not.toContain(SECRET);
  });
});
