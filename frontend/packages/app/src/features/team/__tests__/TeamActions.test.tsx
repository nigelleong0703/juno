import type { PersonView, PossibleMatch } from "@agent-desktop/client";
import { createMockClient } from "@agent-desktop/test-fixtures";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NOW, renderTeam, stubResizeObserver } from "./teamTestKit";

stubResizeObserver();
afterEach(cleanup);

/** One person with an account and an unconfirmed relation, and one suggested account that may be the same person. */
function person(): PersonView {
  return {
    id: "p-1",
    name: "Mina",
    isOwner: false,
    accounts: [{ id: "acc-1", platform: "telegram", name: "Mina T", lastChat: "Family", lastSeen: NOW }],
    relations: [{ id: "rel-1", kind: "friend", kindLabel: null, otherPersonId: "p-2", otherName: "Ola", direction: "out", confirmed: false }],
    lastActivityAt: NOW,
  };
}

function owner(): PersonView {
  return { id: "p-0", name: "Owner", isOwner: true, accounts: [{ id: "acc-0", platform: "discord", name: "robin", lastSeen: NOW }], relations: [], lastActivityAt: NOW };
}

function suggestion(): PossibleMatch {
  return { account: { id: "acc-9", platform: "discord", name: "AlexH", lastSeen: NOW }, person: { id: "p-1", name: "Mina", isOwner: false } };
}

describe("People", () => {
  it("possible matches are one line that opens their list, and linking waits for a confirm", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    renderTeam(
      {
        ...base,
        people: {
          ...base.people,
          list: async () => ({ items: [person()], nextCursor: null }),
          possibleMatches: async () => ({ items: [suggestion()], nextCursor: null }),
          link: async (personId, accountId) => {
            calls.push(`link:${personId}:${accountId}`);
          },
        },
      },
      "/team/people",
    );
    fireEvent.click(await screen.findByRole("button", { name: "1 possible match" }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/team/people/matches"));
    expect(await screen.findByText("Discord · AlexH might be Mina")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Link" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Link AlexH to Mina?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Link" }));
    await waitFor(() => expect(calls).toEqual(["link:p-1:acc-9"]));
  });

  it("an entry is the name, its relation and platforms, and opens the person's page; the owner shows the signed-in name with a You tag", async () => {
    const base = createMockClient({ seed: 7 });
    renderTeam({ ...base, people: { ...base.people, list: async () => ({ items: [owner(), person()], nextCursor: null }) } }, "/team/people", "Robin Lee");
    expect(await screen.findByText("Robin Lee")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.queryByText("Owner")).toBeNull();
    expect(screen.getByTitle("Telegram")).toBeTruthy();
    expect(screen.getByText("Ola's friend")).toBeTruthy();
    // The list has no account or relation controls; they live on the page.
    expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Mina/ }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/team/people/p-1"));
    expect(await screen.findByRole("button", { name: "Mina T on Telegram" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ola's friend" })).toBeTruthy();
  });

  it("the owner's own page speaks to them: 'You reach your team as' and 'You are …'", async () => {
    const base = createMockClient({ seed: 7 });
    const self: PersonView = { ...owner(), relations: [{ id: "rel-7", kind: "works_at", kindLabel: null, otherPersonId: "p-9", otherName: "Acme", direction: "out", confirmed: true }] };
    renderTeam({ ...base, people: { ...base.people, list: async () => ({ items: [self], nextCursor: null }) } }, "/team/people/p-0", "Robin Lee");
    expect(await screen.findByText(/^You reach your team as/u)).toBeTruthy();
    expect(screen.getByText(/^You are/u).textContent).toBe("You are employed by Acme.");
  });

  it("an account opens its sheet, and Unlink asks before it sends", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    renderTeam(
      {
        ...base,
        people: {
          ...base.people,
          list: async () => ({ items: [person()], nextCursor: null }),
          unlinkAccount: async (accountId) => {
            calls.push(`unlink:${accountId}`);
          },
        },
      },
      "/team/people/p-1",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Mina T on Telegram" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(/Last seen in Family/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Unlink" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls).toEqual([]);

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Unlink" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(calls).toEqual(["unlink:acc-1"]));
  });

  it("a relation opens its sheet; Confirm sends the confirm and Remove sends the delete", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    let current = person();
    renderTeam(
      {
        ...base,
        people: {
          ...base.people,
          list: async () => ({ items: [current], nextCursor: null }),
          confirmRelation: async (relationId) => {
            calls.push(`confirm:${relationId}`);
            current = { ...current, relations: current.relations.map((relation) => ({ ...relation, confirmed: true })) };
            return { id: relationId, confirmed: true };
          },
          deleteRelation: async (relationId) => {
            calls.push(`delete:${relationId}`);
          },
        },
      },
      "/team/people/p-1",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Ola's friend" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(calls).toEqual(["confirm:rel-1"]));

    fireEvent.click(await screen.findByRole("button", { name: "Ola's friend" }));
    // Once confirmed there is nothing to confirm any more.
    expect(within(await screen.findByRole("dialog")).queryByRole("button", { name: "Confirm" })).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls).toEqual(["confirm:rel-1", "delete:rel-1"]));
  });

  it("renaming from the top bar's menu shows the new name at once and sends it", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    let current = person();
    renderTeam(
      {
        ...base,
        people: {
          ...base.people,
          list: async () => ({ items: [current], nextCursor: null }),
          rename: async (personId, name) => {
            calls.push(`rename:${personId}:${name}`);
            current = { ...current, name };
          },
        },
      },
      "/team/people/p-1",
    );
    fireEvent.pointerDown(await screen.findByRole("button", { name: "More" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Mina K" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Mina K")).toBeTruthy();
    await waitFor(() => expect(calls).toEqual(["rename:p-1:Mina K"]));
  });

  it("an account that fails to unlink is put back on screen", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    renderTeam(
      {
        ...base,
        people: {
          ...base.people,
          list: async () => ({ items: [person()], nextCursor: null }),
          unlinkAccount: async (accountId) => {
            calls.push(`unlink:${accountId}`);
            throw new Error("server said no");
          },
        },
      },
      "/team/people/p-1",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Mina T on Telegram" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Unlink" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(calls).toEqual(["unlink:acc-1"]));
    expect(await screen.findByRole("button", { name: "Mina T on Telegram" })).toBeTruthy();
  });
});
