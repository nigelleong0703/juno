import { describe, expect, it } from "vitest";
import { survivesRoundTrip } from "./roundTrip";

describe("round-trip guard", () => {
  it("accepts the GFM subset documents are stored in", () => {
    const doc = [
      "# Plan",
      "",
      "Some **bold**, *italic*, `code` and a [link](https://example.com).",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "- [ ] open task",
      "- [x] done task",
      "",
      "> quoted",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(survivesRoundTrip(doc)).toBe(true);
  });

  it("accepts other spellings of the same document", () => {
    expect(survivesRoundTrip("* a\n* b\n\n__bold__ and _it_\n")).toBe(true);
  });

  it("sends content the editor would drop to source mode", () => {
    expect(survivesRoundTrip("Intro\n\n<div class=\"x\">raw html</div>\n")).toBe(false);
    expect(survivesRoundTrip("Look: ![chart](https://example.com/c.png)\n")).toBe(false);
    expect(survivesRoundTrip("Text with a footnote[^1].\n\n[^1]: The note.\n")).toBe(false);
  });
});
