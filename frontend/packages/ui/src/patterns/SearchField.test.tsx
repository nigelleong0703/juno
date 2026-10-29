import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SearchField } from "./SearchField";

function Controlled({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <SearchField
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      placeholder="Search agents"
    />
  );
}

describe("SearchField", () => {
  it("reports typed text through onValueChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);

    await user.type(screen.getByPlaceholderText("Search agents"), "ab");

    expect(screen.getByPlaceholderText("Search agents")).toHaveValue("ab");
    expect(onChange).toHaveBeenLastCalledWith("ab");
  });

  it("only shows the clear button once there is a value", async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    expect(screen.queryByRole("button", { name: "Clear search" })).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search agents"), "x");
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("clears the value when the clear button is pressed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled onChange={onChange} />);

    const input = screen.getByPlaceholderText("Search agents");
    await user.type(input, "hello");
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(input).toHaveValue("");
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("shows the shortcut hint only while empty", async () => {
    const user = userEvent.setup();
    function WithShortcut() {
      const [value, setValue] = useState("");
      return (
        <SearchField
          value={value}
          onValueChange={setValue}
          shortcut="⌘K"
          placeholder="Search"
        />
      );
    }
    render(<WithShortcut />);

    expect(screen.getByText("⌘K")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search"), "a");
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument();
  });
});
