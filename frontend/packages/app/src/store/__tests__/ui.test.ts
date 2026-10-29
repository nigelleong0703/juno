import { beforeEach, describe, expect, it } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { useUiStore } from "../ui";

const values = new Map<string, string>();
const key = "agent-desktop-ui-prefs";
const storage = {
  getItem: (name: string) => values.get(name) ?? null,
  setItem: (name: string, value: string) => { values.set(name, value); },
  removeItem: (name: string) => { values.delete(name); },
};
useUiStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
beforeEach(() => {
  values.clear();
  useUiStore.setState(useUiStore.getInitialState());
});

describe("computer width preference migration", () => {
  it("upgrades only the legacy default and preserves unrelated preferences", async () => {
    values.set(key, JSON.stringify({ version: 0, state: {
      computerPaneSize: 380, sidebarSize: 330, sidebarCollapsed: true, theme: "light",
      compactMode: true,
    } }));
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState()).toMatchObject({
      computerPaneSize: 860, sidebarSize: 330, sidebarCollapsed: true, theme: "light",
      compactMode: true,
    });
    expect(useUiStore.getInitialState().computerPaneSize).toBe(860);
  });

  it("retains a custom width of 650 and preserves subsequent intent across rehydration", async () => {
    values.set(key, JSON.stringify({ version: 0, state: { computerPaneSize: 650, theme: "light" } }));
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().computerPaneSize).toBe(650);
    useUiStore.getState().setComputerPaneSize(460);
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().computerPaneSize).toBe(460);
    expect(useUiStore.getState().theme).toBe("light");
    expect(JSON.parse(storage.getItem(key) ?? "{}").version).toBe(3);
  });

  it("upgrades the version 1 default without changing sidebar, conversation or theme preferences", async () => {
    const unrelated = {
      sidebarSize: 330, sidebarCollapsed: true, sidebarCompact: true, theme: "light",
      computerPanelOpen: false, compactMode: true,
      composeRecipients: [{ key: "draft", kind: "agent", agentId: "agent-juno", name: "Juno" }],
    };
    values.set(key, JSON.stringify({ version: 1, state: { ...unrelated, computerPaneSize: 560 } }));
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState()).toMatchObject({ ...unrelated, computerPaneSize: 860 });
    expect(JSON.parse(storage.getItem(key) ?? "{}")).toEqual({
      version: 3, state: { ...unrelated, computerPaneSize: 860 },
    });
  });

  it("upgrades only the version 2 shipped default and preserves version 2 custom widths", async () => {
    values.set(key, JSON.stringify({ version: 2, state: { computerPaneSize: 680, sidebarSize: 330 } }));
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().computerPaneSize).toBe(860);
    expect(useUiStore.getState().sidebarSize).toBe(330);
    for (const computerPaneSize of [650, 589, 560, 800]) {
      values.set(key, JSON.stringify({ version: 2, state: { computerPaneSize } }));
      await useUiStore.persist.rehydrate();
      expect(useUiStore.getState().computerPaneSize).toBe(computerPaneSize);
    }
    values.set(key, JSON.stringify({ version: 2, state: { theme: "light" } }));
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().computerPaneSize).toBe(860);
  });

  it.each([0, 1])("preserves custom widths and fills missing width for version %i", async (version) => {
    for (const computerPaneSize of [650, 589]) {
      values.set(key, JSON.stringify({ version, state: { computerPaneSize, sidebarSize: 350 } }));
      await useUiStore.persist.rehydrate();
      expect(useUiStore.getState().computerPaneSize).toBe(computerPaneSize);
      expect(useUiStore.getState().sidebarSize).toBe(350);
    }
    values.set(key, JSON.stringify({ version, state: { theme: "light" } }));
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().computerPaneSize).toBe(860);
    expect(useUiStore.getState().theme).toBe("light");
  });

  it("keeps new explicit 560 and 380 choices across version 3 rehydration", async () => {
    for (const width of [560, 380]) {
      useUiStore.getState().setComputerPaneSize(width);
      await useUiStore.persist.rehydrate();
      expect(useUiStore.getState().computerPaneSize).toBe(width);
    }
  });

  it("normalizes legacy undersized widths but does not reinterpret a new narrow-window choice", async () => {
    values.set(key, JSON.stringify({ version: 1, state: { computerPaneSize: 310 } }));
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().computerPaneSize).toBe(420);
    useUiStore.getState().setComputerPaneSize(380);
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().computerPaneSize).toBe(380);
  });
});
