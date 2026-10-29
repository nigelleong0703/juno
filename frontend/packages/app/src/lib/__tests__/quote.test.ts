import { describe, expect, it } from "vitest";
import { quotePrefix, splitQuote } from "../quote";

describe("reply quote", () => {
  it("round-trips a multi-line quote and drops a nested quote from the excerpt", () => {
    const sent = quotePrefix("line one\nline two") + "my answer";
    expect(sent).toBe("> line one\n> line two\n\nmy answer");
    expect(splitQuote(sent)).toEqual({ quote: "line one\nline two", body: "my answer" });
    expect(quotePrefix(sent)).toBe("> my answer\n\n");
  });

  it("leaves plain text alone and truncates long excerpts", () => {
    expect(splitQuote("hello")).toEqual({ body: "hello" });
    expect(quotePrefix("x".repeat(200))).toBe(`> ${"x".repeat(140)}…\n\n`);
  });
});
