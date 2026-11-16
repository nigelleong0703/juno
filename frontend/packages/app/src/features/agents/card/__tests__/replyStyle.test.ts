import { describe, expect, it } from "vitest";
import { parseReplyStyle, replyStyleFor } from "../replyStyle";

const FILE = [
  "# How this user likes to be answered",
  "Last updated from 2026-10-24 conversations.",
  "",
  "- Keep it short. [claim:clm_a1]",
  "- Answer in Dutch when they write Dutch.",
  "## Juno（agt-1）",
  "- Skip the pleasantries with Juno. [claim:clm_b2]",
  "## Sol（agt-2）",
  "- Only for Sol. [claim:clm_c3]",
  '## Agent: "Sol"',
  "- Sol again, no id. [src:itm-9]",
].join("\n");

describe("parseReplyStyle", () => {
  it("drops the title, turns the update line into a date, strips the claim marker and keeps its id", () => {
    const style = parseReplyStyle(replyStyleFor(FILE, "agt-1"));
    expect(style.rules).toEqual([
      { text: "Keep it short.", claimId: "clm_a1" },
      { text: "Answer in Dutch when they write Dutch." },
      { text: "Skip the pleasantries with Juno.", claimId: "clm_b2" },
    ]);
    expect(style.updated).toBeDefined();
    expect([style.updated?.getFullYear(), style.updated?.getMonth(), style.updated?.getDate()]).toEqual([2026, 9, 24]);
  });

  it("shows an agent only the shared rules and its own section, never a section that names an agent without an id", () => {
    const text = replyStyleFor(FILE, "agt-1");
    expect(text).not.toContain("Only for Sol");
    expect(text).not.toContain("Sol again");
    expect(replyStyleFor(FILE, "agt-2")).toContain("Only for Sol.");
    expect(replyStyleFor(FILE, "agt-2")).not.toContain("Sol again");
    expect(parseReplyStyle("- Brief. [claim:c1] [src:itm-1]").rules).toEqual([{ text: "Brief.", claimId: "c1" }]);
  });

  it("reads a file with no header or date line", () => {
    expect(parseReplyStyle("- One. [claim:x]\n- Two.\n")).toEqual({ rules: [{ text: "One.", claimId: "x" }, { text: "Two." }] });
  });

  it("falls back to plain lines when the file has no bullets", () => {
    expect(parseReplyStyle("# Title\nBe brief. [claim:z]").rules).toEqual([{ text: "Be brief.", claimId: "z" }]);
  });
});
