import type { Conversation } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import { channelPlatformsIn, filterChatEntries, platformFilter, type ChatEntry } from "../sidebar/chatEntries";

const AT = "2026-10-19T10:00:00.000Z";
const entry = (id: string, over: Partial<Conversation>): ChatEntry => ({
  name: id,
  agents: [],
  conversation: { id, kind: "direct", agentIds: [], memberIds: [], unreadCount: 0, lastItemAt: AT, ...over } as Conversation,
});

describe("chat filters with channel chats", () => {
  const main = entry("main", {});
  const group = entry("group", { kind: "room", title: "#general · Slack", channel: { kind: "slack", channelId: "c" } });
  const stranger = entry("stranger", { title: "Dana · Slack", channel: { kind: "slack", channelId: "c" }, unreadCount: 1 });
  const all = [main, group, stranger];

  it("keeps platform chats out of the main list and out of Groups (in-app group chats only)", () => {
    const room = entry("room", { kind: "room", title: "Dynamo · Compare & Review" });
    expect(filterChatEntries([...all, room], "all").map((e) => e.name)).toEqual(["main", "room"]);
    expect(filterChatEntries([...all, room], "groups").map((e) => e.name)).toEqual(["room"]);
  });

  it("a platform filter shows every conversation on that platform, owner DMs included", () => {
    const tg = entry("tg", { title: "Telegram · Test", channel: { kind: "telegram", channelId: "t" } });
    const mixed = [...all, tg];
    expect(filterChatEntries(mixed, platformFilter("telegram")).map((e) => e.name)).toEqual(["tg"]);
    expect(filterChatEntries(mixed, platformFilter("slack")).map((e) => e.name)).toEqual(["group", "stranger"]);
    expect(channelPlatformsIn(mixed, ["telegram", "slack", "discord", "feishu"])).toEqual(["telegram", "slack"]);
  });

  it("still surfaces their unread messages", () => {
    expect(filterChatEntries(all, "unread").map((e) => e.name)).toEqual(["stranger"]);
  });
});
