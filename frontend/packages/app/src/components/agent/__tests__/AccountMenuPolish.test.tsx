import { DropdownMenu, ThemeProvider } from "@agent-desktop/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "../AccountMenu";

afterEach(cleanup);

function renderMenu(args: { themeDisabled?: boolean; signOut?: boolean } = {}) {
  const onSettings = vi.fn();
  const onSignOut = vi.fn();
  const onThemeChange = vi.fn();
  render(
    <ThemeProvider defaultTheme="dark">
      <DropdownMenu defaultOpen>
        <AccountMenu
          user={{ name: "Account", initials: "A" }}
          primary={[{ key: "settings", label: "Settings", onSelect: onSettings }]}
          themeLabel="Theme"
          theme="dark"
          themeDisabled={args.themeDisabled}
          themeOptions={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
          ]}
          onThemeChange={onThemeChange}
          signOut={
            args.signOut === false
              ? undefined
              : { key: "sign-out", label: "Sign out", onSelect: onSignOut }
          }
        />
      </DropdownMenu>
    </ThemeProvider>,
  );
  return { onSettings, onSignOut, onThemeChange };
}

describe("AccountMenu polish (GH1 #7)", () => {
  it("keeps every real action wired", () => {
    // The menu closes after each selection, so each action gets a fresh open menu.
    let handlers = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(handlers.onSettings).toHaveBeenCalledOnce();
    cleanup();
    handlers = renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(handlers.onSignOut).toHaveBeenCalledOnce();
  });

  it("disables theme selection until the persisted source loads", () => {
    renderMenu({ themeDisabled: true });
    fireEvent.click(screen.getByRole("menuitem", { name: "Theme" }));
    for (const radio of screen.getAllByRole("menuitemradio")) {
      expect(radio.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("omits Sign out for anonymous identities", () => {
    renderMenu({ signOut: false });
    expect(screen.queryByRole("menuitem", { name: "Sign out" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeDefined();
  });
});
