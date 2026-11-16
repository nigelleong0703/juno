import { describe, expect, it } from "vitest";
import { opensTimeBlock } from "../format";

describe("opensTimeBlock", () => {
  it("opens a block after an hour's pause or on a new day, not between close messages", () => {
    expect(opensTimeBlock("2026-11-06T10:59:00", "2026-11-06T10:00:00")).toBe(false);
    expect(opensTimeBlock("2026-11-06T11:00:00", "2026-11-06T10:00:00")).toBe(true);
    expect(opensTimeBlock("2026-11-07T00:01:00", "2026-11-06T23:59:00")).toBe(true);
    expect(opensTimeBlock("bad", "2026-11-06T10:00:00")).toBe(false);
  });
});
