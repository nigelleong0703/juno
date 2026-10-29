import { describe, expect, it } from "vitest";
import { findActiveMentionToken, matchCandidates, parseMentions } from "../mentions";

const patch = { id: "agent-patch", handle: "patch", name: "Patch" };
const juno = { id: "agent-juno", handle: "juno", name: "Juno" };

describe("parseMentions", () => {
  it("resolves exact handles case-insensitively with canonical labels", () => {
    expect(parseMentions("@patch please check @PATCH", [patch])).toEqual([
      { kind: "agent", id: "agent-patch", label: "@patch" },
    ]);
  });

  it("dedupes repeated mentions of one member", () => {
    expect(parseMentions("@patch and @patch again @Patch", [patch])).toEqual([
      { kind: "agent", id: "agent-patch", label: "@patch" },
    ]);
  });

  it("resolves several members in first-seen order", () => {
    expect(parseMentions("hi @juno and @patch", [patch, juno])).toEqual([
      { kind: "agent", id: "agent-juno", label: "@juno" },
      { kind: "agent", id: "agent-patch", label: "@patch" },
    ]);
  });

  it("ignores email addresses and unknown handles", () => {
    expect(parseMentions("email name@patch and @unknown", [patch])).toEqual([]);
  });

  it("requires a complete token boundary", () => {
    expect(parseMentions("@patch.more is not patch", [patch])).toEqual([]);
    expect(parseMentions("(@patch), ping @patch!", [patch])).toEqual([
      { kind: "agent", id: "agent-patch", label: "@patch" },
    ]);
  });

  it("tolerates a trailing sentence dot", () => {
    expect(parseMentions("please check, @patch.", [patch])).toEqual([
      { kind: "agent", id: "agent-patch", label: "@patch" },
    ]);
  });

  it("ignores handles inside fenced and inline code", () => {
    expect(parseMentions("run `@patch` or ```\n@patch\n``` now", [patch])).toEqual([]);
  });

  it("ignores ambiguous handles shared by two candidates", () => {
    const duplicate = { id: "agent-patch-2", handle: "Patch", name: "Patch Two" };
    expect(parseMentions("@patch hi", [patch, duplicate])).toEqual([]);
  });

  it("never resolves handles outside the candidate list", () => {
    expect(parseMentions("@patch hi", [])).toEqual([]);
    expect(parseMentions("@patch hi", [juno])).toEqual([]);
  });
});

describe("findActiveMentionToken", () => {
  it("finds a handle token ending at the cursor", () => {
    expect(findActiveMentionToken("hi @pa")).toEqual({ start: 3, query: "pa" });
    expect(findActiveMentionToken("@")).toEqual({ start: 0, query: "" });
  });

  it("returns null away from a token or inside an email", () => {
    expect(findActiveMentionToken("hello")).toBeNull();
    expect(findActiveMentionToken("hi @patch ok")).toBeNull();
    expect(findActiveMentionToken("mail name@pa")).toBeNull();
  });
});

describe("matchCandidates", () => {
  it("lists everyone for a bare @ and prefixes otherwise", () => {
    expect(matchCandidates("", [patch, juno])).toEqual([patch, juno]);
    expect(matchCandidates("pa", [patch, juno])).toEqual([patch]);
    expect(matchCandidates("JU", [patch, juno])).toEqual([juno]);
    expect(matchCandidates("zzz", [patch, juno])).toEqual([]);
  });
});
