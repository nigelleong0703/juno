import { describe, expect, it } from "vitest";
import { cardSummary } from "../cardSummary";

describe("cardSummary", () => {
  it("prefers the summary", () => expect(cardSummary({ summary: "S", body: "B" })).toBe("S"));
  it("falls back to the plain start of the body", () => {
    const text = cardSummary({ body: `## Title\n• **Bold** and [link](https://x.y)\n${"字".repeat(300)}` });
    expect(text.startsWith("Title Bold and link")).toBe(true);
    expect(text).toHaveLength(240);
  });
});
