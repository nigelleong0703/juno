import type { ApiClient } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ClientProvider } from "../../../data/ClientProvider";
import { MemoriesPage } from "../MemoriesPage";
import { joinPersonPage, splitPersonPage } from "../personPage";

afterEach(() => cleanup());

function renderPage(client: ApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>
      <ClientProvider client={client} queryClient={queryClient}>
        {children}
      </ClientProvider>
    </MemoryRouter>
  );
  render(<MemoriesPage />, { wrapper });
}

describe("MemoriesPage", () => {
  it("saves MEMORY.md with the hash it loaded; a concurrent change reloads it and tells the user", async () => {
    const client = createMockClient({ seed: 3 });
    renderPage(client);
    const box = (await screen.findByLabelText("MEMORY.md")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toContain("three bullets"));

    fireEvent.change(box, { target: { value: "- Mine\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await client.home.list("MEMORY.md")).files[0]?.content).toBe("- Mine\n"));

    // Someone else writes the file; this page still holds the old hash.
    await client.home.write("MEMORY.md", { content: "- Theirs\n" });
    fireEvent.change(screen.getByLabelText("MEMORY.md"), { target: { value: "- Mine again\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect((await client.home.list("MEMORY.md")).files[0]?.content).toBe("- Theirs\n");
    await waitFor(() => expect((screen.getByLabelText("MEMORY.md") as HTMLTextAreaElement).value).toBe("- Theirs\n"));
  });

  it("forgets the selected claims and removes their lines", async () => {
    const client = createMockClient({ seed: 3 });
    renderPage(client);
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "What I know and why" }));
    fireEvent.click(await screen.findByLabelText("Select: Prefers concise updates: three bullets, no preamble."));
    fireEvent.click(screen.getByRole("button", { name: "Forget 1 selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    await waitFor(async () => expect((await client.memory.claims({ status: "retracted" })).claims.map((c) => c.id)).toContain("claim-01"));
    expect((await client.home.list("MEMORY.md")).files[0]?.content).not.toContain("claim-01");
  });
});

describe("memory search hits", () => {
  it("shows each memory item with the view it is in, and opens the bank file it came from", async () => {
    const client = createMockClient({ seed: 3 });
    await client.home.write("memory/bank/preferences.md", { content: "- Likes window seats [mem:mem_seat]\n" });
    await client.home.write("people/marta.md", { content: "# Marta\n\n- Marta keeps the books [mem:mem_marta]\n" });
    renderPage(client);

    fireEvent.change(await screen.findByPlaceholderText("Search memory…"), { target: { value: "window" } });
    fireEvent.click(await screen.findByText("- Likes window seats"));
    expect(await screen.findByLabelText("memory/bank/preferences.md")).toBeTruthy();
  });

  it("labels a person hit and does not open anything for it", async () => {
    const client = createMockClient({ seed: 3 });
    await client.home.write("people/marta.md", { content: "# Marta\n\n- Marta keeps the books [mem:mem_marta]\n" });
    renderPage(client);

    fireEvent.change(await screen.findByPlaceholderText("Search memory…"), { target: { value: "books" } });
    const row = (await screen.findByText("- Marta keeps the books")).closest("[data-slot='list-row']");
    expect(row?.getAttribute("role")).toBeNull();
    expect(row?.textContent).toContain("People");
  });
});

describe("people pages", () => {
  it("keeps the per-agent sections intact around an edited body", () => {
    const page = "# Marta\n\nThe accountant.\n\n## Ledger（agent-ledger）\n\nSends invoices.\n";
    const { body, sections } = splitPersonPage(page);
    expect(sections.map((s) => s.heading)).toEqual(["Ledger（agent-ledger）"]);
    expect(joinPersonPage(body + "More.\n", sections)).toBe("# Marta\n\nThe accountant.\nMore.\n\n## Ledger（agent-ledger）\n\nSends invoices.\n");
  });
});
