import { describe, expect, it } from "vitest";
import { startedByLine } from "../auditInitiator";

describe("startedByLine", () => {
  it("says who started the work, in the words all three apps use", () => {
    expect(startedByLine({ type: "owner_message", conversationId: "c1" })).toBe("Started by you");
    expect(startedByLine({ type: "channel", channel: "telegram", conversationId: "c1", speaker: "stranger" })).toBe("Started by a stranger on Telegram");
    expect(startedByLine({ type: "channel", channel: "slack", conversationId: "c1", speaker: "member" })).toBe("Started by a member on Slack");
    expect(startedByLine({ type: "channel", channel: "discord", conversationId: "c1", speaker: "owner" })).toBe("Started by you on Discord");
    expect(startedByLine({ type: "routine", routineId: "r1", occurrenceAt: "2026-10-29T08:00:00.000Z" }, "Daily digest")).toBe("Started by a routine · Daily digest");
    expect(startedByLine({ type: "routine", routineId: "r1", occurrenceAt: "2026-10-29T08:00:00.000Z" })).toBe("Started by a routine");
    expect(startedByLine({ type: "system", wakeKind: "task_done" })).toBe("Started by the system · task done");
    expect(startedByLine({ type: "system", wakeKind: "webhook", label: "GitHub push" })).toBe("Started by the system · GitHub push");
    expect(startedByLine({ type: "system", wakeKind: "system" })).toBe("Started by the system");
  });
});
