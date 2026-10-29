import type { Item } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import {
  mergeItemChronologically,
  replaceOptimisticItem,
  sortItemsChronologically,
} from "../events";

function system(id: string, at: string, text = id): Item {
  return { id, conversationId: "conv-1", at, type: "system", level: "info", text };
}

function user(id: string, at: string, text = id): Item {
  return {
    id,
    conversationId: "conv-1",
    at,
    type: "user_message",
    authorId: "member-1",
    text,
    attachments: [],
    mentions: [],
  };
}

describe("chronological item order", () => {
  it("sorts fetched items by `at`, reproducing the owner's late-listed reply", () => {
    // Owner baseline 2026-10-05: the agent's "Hi" (42.846Z) was listed after the long answer
    // (56.284Z), so it rendered below a reply that came later.
    const items = [
      system("user-first", "2026-10-05T14:54:40.755Z"),
      system("user-second", "2026-10-05T14:54:49.085Z"),
      system("answer-late", "2026-10-05T14:54:56.284Z"),
      system("hi-early", "2026-10-05T14:54:42.846Z"),
    ];

    expect(sortItemsChronologically(items).map((item) => item.id)).toEqual([
      "user-first",
      "hi-early",
      "user-second",
      "answer-late",
    ]);
  });

  it("keeps arrival order for items sharing an instant", () => {
    const items = [
      system("b", "2026-10-05T00:00:00.000Z"),
      system("a", "2026-10-05T00:00:00.000Z"),
    ];

    expect(sortItemsChronologically(items).map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the array it was given", () => {
    const items = [
      system("late", "2026-10-05T00:00:02.000Z"),
      system("early", "2026-10-05T00:00:01.000Z"),
    ];

    sortItemsChronologically(items);

    expect(items.map((item) => item.id)).toEqual(["late", "early"]);
  });

  it("inserts a late-streamed item into place and replaces a duplicate id", () => {
    const items = [
      system("a", "2026-10-05T00:00:01.000Z"),
      system("c", "2026-10-05T00:00:03.000Z"),
    ];

    const merged = mergeItemChronologically(items, system("b", "2026-10-05T00:00:02.000Z"));
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);

    const replaced = mergeItemChronologically(
      merged,
      system("b", "2026-10-05T00:00:02.000Z", "updated"),
    );
    expect(replaced).toHaveLength(3);
    expect(replaced.find((item) => item.id === "b")).toMatchObject({ text: "updated" });
  });
});

describe("optimistic send dedupe", () => {
  it("swaps the placeholder for the stored item", () => {
    const items = [user("temp-1", "2026-10-05T00:00:01.000Z", "hello")];
    const next = replaceOptimisticItem(
      items,
      "temp-1",
      user("srv-9", "2026-10-05T00:00:01.000Z", "hello"),
    );
    expect(next.map((item) => item.id)).toEqual(["srv-9"]);
  });

  it("replaces rather than duplicates a live echo that arrived first", () => {
    const echo = user("srv-9", "2026-10-05T00:00:01.000Z", "hello");
    const items = [user("temp-1", "2026-10-05T00:00:01.000Z", "hello"), echo];
    const next = replaceOptimisticItem(items, "temp-1", echo);
    expect(next.map((item) => item.id)).toEqual(["srv-9"]);
  });

  it("converges when nothing is cached", () => {
    const next = replaceOptimisticItem(
      [],
      "temp-1",
      user("srv-9", "2026-10-05T00:00:01.000Z", "hello"),
    );
    expect(next.map((item) => item.id)).toEqual(["srv-9"]);
  });
});
