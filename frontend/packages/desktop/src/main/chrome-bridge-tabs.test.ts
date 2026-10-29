import { describe, expect, it } from "vitest";
import { isSensitiveField } from "../../chrome-extension/extension/cdp.js";
import { RefRegistry } from "../../chrome-extension/extension/refs.js";
import { TabScope } from "../../chrome-extension/extension/tab-scope.js";

describe("Chrome bridge tab and ref scope", () => {
  it("never treats passwords, payment autofill or one-time codes as plaintext-editable fields", () => {
    expect(isSensitiveField("password", "")).toBe(true);
    expect(isSensitiveField("text", "cc-number")).toBe(true);
    expect(isSensitiveField("text", "section-payment cc-csc")).toBe(true);
    expect(isSensitiveField("text", "one-time-code")).toBe(true);
    expect(isSensitiveField("text", "email")).toBe(false);
    expect(isSensitiveField("text", undefined)).toBe(false);
  });

  it("keeps explicit grants, agent handles and refs isolated per agent", () => {
    const tabs = new TabScope();
    const refs = new RefRegistry();
    tabs.grant(7, null);
    tabs.grant(8, "agent-a");

    expect(tabs.accessibleTabs("agent-a").map((tab) => tab.tabId)).toEqual([7, 8]);
    expect(tabs.accessibleTabs("agent-b").map((tab) => tab.tabId)).toEqual([7]);
    const agentATab = tabs.handle("agent-a", 8);
    expect(agentATab).toMatch(/^mt[0-9a-z]+$/);
    expect(() => tabs.resolve("agent-b", agentATab)).toThrow(/unknown or revoked/);
    expect(() => tabs.resolve("agent-a", "t2")).toThrow(/invalid Mac tab handle/);

    const refA = refs.capture("agent-a", 7, "t1", [{ frameId: "f1", loaderId: "load-1", backendNodeId: 41 }])[0]!;
    expect(refs.resolve("agent-a", refA)).toMatchObject({ tabId: 7, frameId: "f1", loaderId: "load-1" });
    expect(() => refs.resolve("agent-b", refA)).toThrow(/unknown or stale/);
    expect(refA).toMatch(/^mac_e[1-9][0-9]*$/);
    expect(() => refs.resolve("agent-a", "e1")).toThrow(/invalid browser ref/);
  });

  it("invalidates old tab refs on snapshot, reload, detach or close without reusing ref numbers", () => {
    const tabs = new TabScope();
    const refs = new RefRegistry();
    tabs.grant(4, "agent-a");
    const first = refs.capture("agent-a", 4, tabs.handle("agent-a", 4), [
      { frameId: "f1", loaderId: "load-1", backendNodeId: 11 },
      { frameId: "f1", loaderId: "load-1", backendNodeId: 12 },
    ]);
    const second = refs.capture("agent-a", 4, tabs.handle("agent-a", 4), [{ frameId: "f1", loaderId: "load-2", backendNodeId: 21 }]);

    expect(() => refs.resolve("agent-a", first[0]!)).toThrow(/stale/);
    expect(second[0]).not.toBe(first[1]);
    refs.invalidateTab(4);
    expect(() => refs.resolve("agent-a", second[0]!)).toThrow(/stale/);

    const handle = tabs.handle("agent-a", 4);
    const third = refs.capture("agent-a", 4, handle, [{ frameId: "f1", loaderId: "load-3", backendNodeId: 31 }]);
    tabs.close(4);
    refs.invalidateTab(4);
    expect(() => tabs.resolve("agent-a", handle)).toThrow(/unknown or revoked/);
    expect(() => refs.resolve("agent-a", third[0]!)).toThrow(/stale/);
  });
});
