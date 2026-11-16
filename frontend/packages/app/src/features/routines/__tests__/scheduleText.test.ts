import { describe, expect, it } from "vitest";
import { scheduleText } from "../cron";

describe("scheduleText", () => {
  it("never shows a raw cron that an agent stored as the routine's phrase (the \"0 8 * * *\" rows)", () => {
    expect(scheduleText("0 8 * * *", "0 8 * * *")).toBe("Every day at 8:00");
    expect(scheduleText("30 7 * * 1-5", "30 7 * * 1-5")).not.toMatch(/\*/);
    expect(scheduleText("30 7 * * 1-5", undefined)).toMatch(/07:30/);
  });

  it("keeps a real phrase, and falls back to Scheduled when nothing can be read", () => {
    expect(scheduleText("15 6 * * *", "Before the gym")).toBe("Before the gym");
    expect(scheduleText("not a cron", "")).toBe("Scheduled");
  });
});
