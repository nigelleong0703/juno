import { describe, expect, it } from "vitest";
import { hashForDeepLink, hashForRequest } from "./deep-link";

describe("hashForDeepLink", () => {
  it("lands connector OAuth returns on the connectors tab with the status", () => {
    expect(hashForDeepLink("agentdesktop://plugins?tab=connectors&status=connected")).toBe("#/plugins?tab=connectors&status=connected");
  });
  it("drops trailing slashes", () => {
    expect(hashForDeepLink("agentdesktop://plugins/")).toBe("#/plugins");
  });
});

describe("hashForRequest", () => {
  it("opens the request's conversation", () => {
    expect(hashForRequest("conv-1")).toBe("#/c/conv-1");
  });
  it("falls back to Home when the request has no conversation", () => {
    expect(hashForRequest(undefined)).toBe("#/");
  });
});
