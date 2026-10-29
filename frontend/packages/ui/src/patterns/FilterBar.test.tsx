import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterBar, FilterChip } from "./FilterBar";

describe("FilterBar / FilterChip", () => {

  it("reports a chip toggle and marks active chips", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <FilterBar>
        <FilterChip label="Unread" onClick={onClick} />
        <FilterChip label="Active" active onClick={() => {}} />
      </FilterBar>,
    );

    await user.click(screen.getByRole("button", { name: "Unread" }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Active" })).toHaveClass(
      "bg-accent-subtle",
    );
  });

  it("removes a chip without also toggling it", async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    const onClick = vi.fn();
    render(
      <FilterBar>
        <FilterChip label="Unread" onClick={onClick} onRemove={onRemove} />
      </FilterBar>,
    );

    await user.click(screen.getByRole("button", { name: "Remove filter" }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("calls onClear from the clear button", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <FilterBar onClear={onClear}>
        <FilterChip label="Unread" />
      </FilterBar>,
    );

    await user.click(screen.getByRole("button", { name: "Clear all" }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

});
