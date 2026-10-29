import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu } from "@agent-desktop/ui";
import { AccountMenu } from "../AccountMenu";

// vitest runs without globals, so testing-library's automatic cleanup is not registered.
afterEach(cleanup);

function renderOpen(props?: Partial<Parameters<typeof AccountMenu>[0]>) {
  const onSettings = vi.fn();
  const onThemeChange = vi.fn();
  render(
    <DropdownMenu open modal={false}>
      <AccountMenu
        user={{ name: "Robin", initials: "N" }}
        primary={[{ key: "settings", label: "Settings", onSelect: onSettings }]}
        themeLabel="Theme"
        theme="dark"
        themeOptions={[
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ]}
        onThemeChange={onThemeChange}
        {...props}
      />
    </DropdownMenu>,
  );
  return { onSettings, onThemeChange };
}

describe("AccountMenu", () => {
  it("opens the theme submenu and switches with the radio group", () => {
    const { onThemeChange } = renderOpen();
    fireEvent.click(screen.getByText("Theme"));
    fireEvent.click(screen.getByText("Light"));
    expect(onThemeChange).toHaveBeenCalledWith("light");
  });

  it("fires the primary entry", () => {
    const { onSettings } = renderOpen();
    fireEvent.click(screen.getByText("Settings"));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});
