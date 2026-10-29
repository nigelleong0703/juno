import { describe, expect, it } from "vitest";
import {
  insertMentionDraft,
  reconcileMentionDrafts,
  serializeMentionDraft,
  type MentionDraftSpan,
} from "../mention-draft";

const patch = { id: "agent-patch", handle: "patch", name: "Engineering Lead" };
const juno = { id: "agent-juno", handle: "juno", name: "Juno" };

describe("insertMentionDraft", () => {
  it("inserts the display name with a trailing space and tracks the span", () => {
    const result = insertMentionDraft("hi @pa", 3, 6, patch);
    expect(result?.value).toBe("hi Engineering Lead ");
    expect(result?.span).toEqual({ id: "agent-patch", name: "Engineering Lead", start: 3, end: 19 });
  });

  it("returns null when the candidate has no display name", () => {
    expect(insertMentionDraft("@ha", 0, 3, { id: "a", handle: "hal" })).toBeNull();
  });
});

describe("reconcileMentionDrafts", () => {
  const span: MentionDraftSpan = { id: patch.id, name: patch.name, start: 0, end: 16 };

  it("shifts spans when text is inserted before the name", () => {
    const next = reconcileMentionDrafts("yo Engineering Lead ", "yo yo Engineering Lead ", [
      { id: patch.id, name: patch.name, start: 3, end: 19 },
    ]);
    expect(next).toEqual([{ id: patch.id, name: patch.name, start: 6, end: 22 }]);
  });

  it("clears spans touched by the edit", () => {
    expect(reconcileMentionDrafts("Engineering Lead ", "Engineering Lea", [span])).toEqual([]);
    expect(reconcileMentionDrafts("Engineering Lead ", "ordinary message", [span])).toEqual([]);
  });

  it("keeps spans before appended text", () => {
    expect(reconcileMentionDrafts("Engineering Lead ", "Engineering Lead please review.", [span])).toEqual([
      span,
    ]);
  });
});

describe("serializeMentionDraft", () => {
  it("serializes a valid span to the canonical handle and ID", () => {
    const span: MentionDraftSpan = { id: patch.id, name: patch.name, start: 0, end: 16 };
    const result = serializeMentionDraft("Engineering Lead please review.", [span], [patch]);
    expect(result.text).toBe("@patch please review.");
    expect(result.mentions).toEqual([{ kind: "agent", id: "agent-patch", label: "@patch" }]);
  });

  it("treats a typed name without a span as plain text", () => {
    const result = serializeMentionDraft("Engineering Lead please review.", [], [patch]);
    expect(result.text).toBe("Engineering Lead please review.");
    expect(result.mentions).toEqual([]);
  });

  it("invalidates spans whose member is gone and keeps explicit handles", () => {
    const span: MentionDraftSpan = { id: "agent-gone", name: "Ghost", start: 0, end: 5 };
    const result = serializeMentionDraft("Ghost hi @juno", [span], [juno]);
    expect(result.text).toBe("Ghost hi @juno");
    expect(result.mentions).toEqual([{ kind: "agent", id: "agent-juno", label: "@juno" }]);
  });

  it("lets the explicit ID win when handles are ambiguous", () => {
    const dupes = [
      { id: "agent-sam-a", handle: "sam", name: "Sam" },
      { id: "agent-sam-b", handle: "sam", name: "Sam" },
    ];
    const span: MentionDraftSpan = { id: "agent-sam-b", name: "Sam", start: 0, end: 3 };
    const result = serializeMentionDraft("Sam ", [span], dupes);
    expect(result.text).toBe("@sam");
    expect(result.mentions).toEqual([{ kind: "agent", id: "agent-sam-b", label: "@sam" }]);
  });
});

it("preserves each occurrence but dedupes the recipient ID", () => {
  const spans = [
    { id: "agent-patch", name: "Patch", start: 0, end: 5 },
    { id: "agent-patch", name: "Patch", start: 10, end: 15 },
  ];
  const result = serializeMentionDraft("Patch and Patch", spans, [patch]);
  expect(result.text).toBe("@patch and @patch");
  expect(result.mentions).toEqual([{ kind: "agent", id: "agent-patch", label: "@patch" }]);
});
