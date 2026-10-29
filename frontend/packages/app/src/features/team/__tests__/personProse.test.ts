import type { PersonRelationView } from "@agent-desktop/client";
import { describe, expect, it } from "vitest";
import { accountHandle, relationPhrase } from "../personProse";

function relation(patch: Partial<PersonRelationView>): PersonRelationView {
  return { id: "r", kind: "friend", kindLabel: null, otherPersonId: "p-2", otherName: "Ola", direction: "out", confirmed: true, ...patch };
}

describe("person prose", () => {
  it("a relation reads from the person's side, whichever end of the relation they are", () => {
    expect(relationPhrase(relation({ kind: "friend" }))).toBe("Ola's friend");
    expect(relationPhrase(relation({ kind: "manager_of", direction: "out" }))).toBe("Ola's manager");
    expect(relationPhrase(relation({ kind: "manager_of", direction: "in" }))).toBe("Ola's report");
    expect(relationPhrase(relation({ kind: "parent_of", direction: "in" }))).toBe("Ola's child");
    expect(relationPhrase(relation({ kind: "works_at", otherName: "Acme" }))).toBe("works at Acme");
    expect(relationPhrase(relation({ kind: "other", kindLabel: "neighbour" }))).toBe("Ola's neighbour");
  });

  it("a kind this client has no words for reads as the server's word, never as a message key", () => {
    expect(relationPhrase(relation({ kind: "business_partner" }))).toBe("Ola's business partner");
  });

  it("a handle is @name; a display name with spaces and a missing name are not made into handles", () => {
    expect(accountHandle({ name: "AlexH" })).toBe("@AlexH");
    expect(accountHandle({ name: "@big" })).toBe("@big");
    expect(accountHandle({ name: "Mina T" })).toBe("Mina T");
    expect(accountHandle({ name: null })).toBeUndefined();
  });
});
