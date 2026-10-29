import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { CommandMenu, type CommandMenuGroup } from "./CommandMenu";

const groups: CommandMenuGroup[] = [
  {
    heading: "Actions",
    items: [
      { id: "new", label: "New agent", keywords: ["create", "spawn"] },
      { id: "deploy", label: "Deploy workflow", keywords: ["ship"] },
    ],
  },
  {
    heading: "Navigation",
    items: [{ id: "settings", label: "Open settings", keywords: ["preferences"] }],
  },
];

function renderMenu(overrides: Partial<ComponentProps<typeof CommandMenu>> = {}) {
  const onOpenChange = vi.fn();
  const utils = render(
    <CommandMenu open onOpenChange={onOpenChange} groups={groups} {...overrides} />,
  );
  return { onOpenChange, ...utils };
}

describe("CommandMenu", () => {
  it("lists every item from the groups while open", () => {
    renderMenu();
    expect(screen.getByText("New agent")).toBeInTheDocument();
    expect(screen.getByText("Deploy workflow")).toBeInTheDocument();
    expect(screen.getByText("Open settings")).toBeInTheDocument();
  });

  it("filters items as the user types", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.type(screen.getByPlaceholderText("Type a command or search…"), "deploy");

    expect(screen.getByText("Deploy workflow")).toBeInTheDocument();
    expect(screen.queryByText("New agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Open settings")).not.toBeInTheDocument();
  });

  it("matches on keywords, not only the visible label", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.type(screen.getByPlaceholderText("Type a command or search…"), "spawn");

    expect(screen.getByText("New agent")).toBeInTheDocument();
    expect(screen.queryByText("Deploy workflow")).not.toBeInTheDocument();
  });

  it("shows the empty message when nothing matches", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.type(
      screen.getByPlaceholderText("Type a command or search…"),
      "zzzzz-no-match",
    );

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.queryByText("New agent")).not.toBeInTheDocument();
  });

  it("runs the item action and closes the menu on selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const menuGroups: CommandMenuGroup[] = [
      { heading: "Actions", items: [{ id: "new", label: "New agent", onSelect }] },
    ];
    const { onOpenChange } = renderMenu({ groups: menuGroups });

    await user.click(screen.getByText("New agent"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderMenu();

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renders nothing while closed", () => {
    render(
      <CommandMenu open={false} onOpenChange={vi.fn()} groups={groups} />,
    );
    expect(screen.queryByText("New agent")).not.toBeInTheDocument();
  });
});
