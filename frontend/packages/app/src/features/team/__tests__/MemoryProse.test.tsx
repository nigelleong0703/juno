import { createMockClient } from "@agent-desktop/test-fixtures";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { memory, renderTeam, stubResizeObserver, topic, withMemory } from "./teamTestKit";

stubResizeObserver();
afterEach(cleanup);

const identity = memory({ id: "m-id1", text: "Lives in Kuala Lumpur", topic: "identity" });
const born = memory({ id: "m-id2", text: "Born in 1990", topic: "identity" });
const sugar = memory({ id: "m-h1", text: "Is cutting sugar", topic: "health", sensitive: true });
const muscle = memory({ id: "m-h2", text: "Wants to build muscle", topic: "health", audience: { kind: "group", label: "Gym crew" }, saidBy: { kind: "owner", name: "Owner" } });
const oat = memory({ id: "m-p1", text: "Likes oat milk", topic: "preferences" });
const topics = [
  topic({ topic: "identity", label: "Identity", summary: "", segments: [], count: 2 }),
  topic({
    topic: "health",
    label: "Health",
    summary: "You are building muscle and cutting sugar.",
    segments: [
      { text: "You are " },
      { text: "building muscle", itemId: "m-h2" },
      { text: " and " },
      { text: "cutting sugar", itemId: "m-h1" },
      { text: "." },
    ],
    count: 2,
  }),
  topic({ topic: "people", label: "People", summary: "Mina is a friend.", segments: [{ text: "Mina is a friend." }], count: 1 }),
  topic({ topic: "agents", label: "Agents", summary: "Juno writes your notes.", segments: [{ text: "Juno writes your notes." }], count: 1 }),
  topic({ topic: "preferences", label: "Preferences", summary: "You like oat milk.", segments: [{ text: "You like " }, { text: "oat milk", itemId: "m-p1" }, { text: "." }], count: 1 }),
];
const everything = [identity, born, sugar, muscle, oat];

describe("Memory", () => {
  it("each topic is a paragraph under its label, in the fixed order, with no cards", async () => {
    renderTeam(withMemory(createMockClient({ seed: 7 }), everything, topics), "/team/memory");
    await screen.findByRole("button", { name: "cutting sugar" });
    const labels = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(labels).toEqual(["Identity", "Health", "Preferences", "Agents", "People"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("What your team knows about you");
    expect(screen.getByText("From your chats", { exact: false })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Memory" })).toBeNull();
    expect(screen.queryByText("2 memories", { exact: false })).toBeNull();
    for (const name of ["All", "About you", "About others", "Groups"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("segments with an item are tappable phrases and the rest is plain text", async () => {
    renderTeam(withMemory(createMockClient({ seed: 7 }), everything, topics), "/team/memory");
    expect(await screen.findByRole("button", { name: "building muscle" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "cutting sugar" })).toBeTruthy();
    // The plain pieces of the sentence, and a summary with no item in it, are not buttons.
    expect(screen.queryByRole("button", { name: /You are/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Mina is a friend/ })).toBeNull();
    expect(screen.getByText("Mina is a friend.")).toBeTruthy();
  });

  it("a topic with no summary reads its items as sentences, each tappable", async () => {
    renderTeam(withMemory(createMockClient({ seed: 7 }), everything, topics), "/team/memory");
    expect(await screen.findByRole("button", { name: "Lives in Kuala Lumpur." })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Born in 1990." }));
    const sheet = await screen.findByRole("dialog");
    expect((within(sheet).getByRole("textbox", { name: "Memory text" }) as HTMLTextAreaElement).value).toBe("Born in 1990");
  });

  it("tapping a phrase opens the Memory dialog with that item: its text, who can hear it, Keep private and Forget", async () => {
    const date = new Date("2026-10-20T08:00:00.000Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    renderTeam(withMemory(createMockClient({ seed: 7 }), everything, topics), "/team/memory");
    fireEvent.click(await screen.findByRole("button", { name: "cutting sugar" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "Memory" })).toBeTruthy();
    expect((within(sheet).getByRole("textbox", { name: "Memory text" }) as HTMLTextAreaElement).value).toBe("Is cutting sugar");
    // No quote on this item (null), so the sheet says where and when it was made.
    expect(within(sheet).getByText(`Your chat · ${date}`)).toBeTruthy();
    expect(within(sheet).getByRole("radio", { name: "Only you" }).getAttribute("aria-checked")).toBe("true");
    expect(within(sheet).getByRole("radio", { name: "Everyone" }).getAttribute("aria-checked")).toBe("false");
    expect(within(sheet).queryByRole("radio", { name: "Gym crew" })).toBeNull();
    expect(within(sheet).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(within(sheet).getByText("Keep private")).toBeTruthy();
    expect(within(sheet).getByText("Only used in your private chats, never in groups.")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Forget" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Edit" })).toBeNull();

    // Another phrase is another item: this one was said in a group and by the person being helped.
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "building muscle" }));
    const second = await screen.findByRole("dialog");
    expect((within(second).getByRole("textbox", { name: "Memory text" }) as HTMLTextAreaElement).value).toBe("Wants to build muscle");
    expect(within(second).getByText(`Said by you · Your chat · ${date}`)).toBeTruthy();
    expect(within(second).getByRole("radio", { name: "Gym crew" }).getAttribute("aria-checked")).toBe("true");
    expect(within(second).getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("an item with a quote shows the person's own words, with where and when the quote was said under it", async () => {
    const said = new Date("2026-09-02T10:00:00.000Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    renderTeam(withMemory(createMockClient({ seed: 7 }), [{ ...oat, quote: { text: "I only drink oat milk", at: "2026-09-02T10:00:00.000Z" } }], [topics[4]!]), "/team/memory");
    fireEvent.click(await screen.findByRole("button", { name: "oat milk" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("“I only drink oat milk”")).toBeTruthy();
    expect(within(sheet).getByText(`Your chat · ${said}`)).toBeTruthy();
  });

  it("the provenance line carries the writing agent's avatar", async () => {
    const base = createMockClient({ seed: 7 });
    const [agent] = (await base.agents.list()).items;
    if (!agent) throw new Error("the mock world has no agent");
    renderTeam(withMemory(base, [{ ...oat, agentId: agent.id }], [topics[4]!]), "/team/memory");
    fireEvent.click(await screen.findByRole("button", { name: "oat milk" }));
    const source = within(await screen.findByRole("dialog")).getByText(/Your chat/);
    await waitFor(() => expect(source.parentElement?.children.length).toBe(2));
  });

  it("the audience control and the switch change who can hear the fact at once", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    const client = withMemory(base, everything, topics);
    renderTeam(
      { ...client, memoryItems: { ...client.memoryItems, update: async (id, patch) => void calls.push(`update:${id}:${JSON.stringify(patch)}`) } },
      "/team/memory",
    );
    fireEvent.click(await screen.findByRole("button", { name: "cutting sugar" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("radio", { name: "Everyone" }));
    await waitFor(() => expect(calls).toEqual([`update:m-h1:${JSON.stringify({ audience: "public" })}`]));
    fireEvent.click(within(sheet).getByRole("switch"));
    await waitFor(() => expect(calls).toContain(`update:m-h1:${JSON.stringify({ sensitive: false })}`));
  });

  it("the text is an editable field, and Save is enabled only after a change and sends only the text", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    const client = withMemory(base, everything, topics);
    renderTeam(
      { ...client, memoryItems: { ...client.memoryItems, update: async (id, patch) => void calls.push(`update:${id}:${JSON.stringify(patch)}`) } },
      "/team/memory",
    );
    fireEvent.click(await screen.findByRole("button", { name: "oat milk" }));
    const sheet = await screen.findByRole("dialog");
    const box = within(sheet).getByRole("textbox", { name: "Memory text" }) as HTMLTextAreaElement;
    expect(box.value).toBe("Likes oat milk");
    const save = () => within(sheet).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.change(box, { target: { value: "   " } });
    expect(save().disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Likes oat milk in the morning" } });
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(calls).toEqual([`update:m-p1:${JSON.stringify({ text: "Likes oat milk in the morning" })}`]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Forget asks first, then removes the fact and closes the sheet", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    const items = [...everything];
    const client = withMemory(base, items, topics);
    renderTeam(
      {
        ...client,
        memoryItems: {
          ...client.memoryItems,
          delete: async (id) => {
            calls.push(`delete:${id}`);
            items.splice(0, items.length, ...items.filter((item) => item.id !== id));
          },
        },
      },
      "/team/memory",
    );
    fireEvent.click(await screen.findByRole("button", { name: "oat milk" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Forget" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls).toEqual([]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Forget" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(calls).toEqual(["delete:m-p1"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("search is an icon in the top bar that lists the matching items of every topic", async () => {
    renderTeam(withMemory(createMockClient({ seed: 7 }), everything, topics), "/team/memory");
    expect(screen.queryByPlaceholderText("Search memory")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Search memory" }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/team/memory/search"));
    const field = await screen.findByPlaceholderText("Search memory");
    fireEvent.change(field, { target: { value: "oat" } });
    expect(await screen.findByText("Likes oat milk")).toBeTruthy();
    expect(screen.queryByText("Lives in Kuala Lumpur")).toBeNull();
    fireEvent.click(screen.getByText("Likes oat milk"));
    expect((within(await screen.findByRole("dialog")).getByRole("textbox", { name: "Memory text" }) as HTMLTextAreaElement).value).toBe("Likes oat milk");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.change(field, { target: { value: "zzz" } });
    expect(await screen.findByText("Nothing matches.")).toBeTruthy();
  });

  it("the review line shows while items wait, and Keep takes an item out of the queue", async () => {
    const base = createMockClient({ seed: 7 });
    const calls: string[] = [];
    let review = [memory()];
    renderTeam(
      {
        ...base,
        memoryItems: {
          ...base.memoryItems,
          list: async () => ({ items: [], nextCursor: null }),
          review: async () => ({ items: review }),
          resolveReview: async (id, input) => {
            calls.push(`resolve:${id}:${input.action}`);
            review = review.filter((item) => item.id !== id);
          },
        },
      },
      "/team/memory",
    );
    fireEvent.click(await screen.findByRole("button", { name: "1 thing to check" }));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/team/memory/review"));
    fireEvent.click(await screen.findByRole("button", { name: "Keep" }));
    await waitFor(() => expect(calls).toEqual(["resolve:m-1:keep"]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Keep" })).toBeNull());
  });
});
