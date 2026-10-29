import type { Item } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import { sendFailureReason, withRefused, type FailedSend } from "../outbox";

const AT = "2026-10-11T10:00:00.000Z";

function message(id: string, at: string, text: string, conversationId = "c1"): Item {
  return { id, conversationId, at, type: "user_message", authorId: "me", text, attachments: [], mentions: [] };
}

function refusal(item: Item): FailedSend {
  return {
    tempId: item.id,
    identity: { messageId: item.id, runId: "run-test" },
    conversationId: item.conversationId,
    payload: { text: item.type === "user_message" ? item.text : "" } as FailedSend["payload"],
    reason: "nope",
    item,
  };
}

describe("sendFailureReason", () => {
  it("names a network failure (fetch rejects with a TypeError)", () => {
    expect(sendFailureReason(new TypeError("Failed to fetch"))).toBe("network unavailable");
  });

  it("uses the server's own message when it gave one", () => {
    const err = Object.assign(new Error("Conversation is archived"), { status: 409 });
    expect(sendFailureReason(err)).toBe("Conversation is archived");
  });

  it("falls back to server error for an HTTP status with no message", () => {
    const err = Object.assign(new Error("HTTP 500"), { status: 500 });
    expect(sendFailureReason(err)).toBe("server error");
  });

  it("is unknown for anything else", () => {
    expect(sendFailureReason("boom")).toBe("unknown error");
  });
});

describe("withRefused", () => {
  it("puts a refused placeholder back into a list a refetch dropped it from", () => {
    const refused = message("optimistic-2", "2026-10-11T10:05:00.000Z", "Retry me");
    const server = [message("m1", AT, "Earlier")];
    const shown = withRefused(server, { [refused.id]: refusal(refused) }, "c1");
    expect(shown.map((item) => item.id)).toEqual(["m1", "optimistic-2"]);
  });

  it("does not duplicate a placeholder that is already listed", () => {
    const refused = message("optimistic-3", AT, "Once");
    const shown = withRefused([refused], { [refused.id]: refusal(refused) }, "c1");
    expect(shown).toHaveLength(1);
  });

  it("ignores refusals from other conversations", () => {
    const refused = message("optimistic-4", AT, "Elsewhere", "c2");
    expect(withRefused([], { [refused.id]: refusal(refused) }, "c1")).toEqual([]);
  });
});
